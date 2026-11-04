"""Leakage-safe, explainable forecast aids for small orders, retained deposits and locks."""
from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timedelta
from math import isfinite
from statistics import median
from typing import Any, Iterable, Mapping, Sequence

TARGET_METRICS = {"小订数量", "留存大定", "交车锁单"}
GRAINS = ("day", "week", "month")
MAX_BACKTEST_WINDOWS = {"day": 56, "week": 26, "month": 24}
MAX_TRAIN_PERIODS = {"day": 366, "week": 156, "month": 60}
MIN_FACTOR_SAMPLES = {"day": 8, "week": 4, "month": 2}
MIN_BACKTEST_SAMPLES = {"day": 8, "week": 4, "month": 2}


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _series_key(row: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    def field(name: str) -> str:
        value = row.get(name)
        return "" if value is None else str(value)
    return tuple(field(name) for name in ("model", "metric", "stage", "cycle", "source"))


def _month_start(day: date) -> date:
    return date(day.year, day.month, 1)


def _next_month(day: date) -> date:
    return date(day.year + 1, 1, 1) if day.month == 12 else date(day.year, day.month + 1, 1)


def _period_start(day: date, grain: str) -> date:
    if grain == "day":
        return day
    if grain == "week":
        return day - timedelta(days=day.weekday())
    return _month_start(day)


def _period_end(start: date, grain: str) -> date:
    if grain == "day":
        return start
    if grain == "week":
        return start + timedelta(days=6)
    return _next_month(start) - timedelta(days=1)


def _period_days(start: date, grain: str) -> int:
    return (_period_end(start, grain) - start).days + 1


def _previous_start(start: date, grain: str) -> date:
    if grain == "day":
        return start - timedelta(days=1)
    if grain == "week":
        return start - timedelta(days=7)
    return _month_start(start - timedelta(days=1))


def _next_start(start: date, grain: str) -> date:
    if grain == "day":
        return start + timedelta(days=1)
    if grain == "week":
        return start + timedelta(days=7)
    return _next_month(start)


def _complete_periods(daily: Mapping[date, float], grain: str) -> list[dict[str, Any]]:
    grouped: dict[date, dict[date, float]] = defaultdict(dict)
    for day, value in daily.items():
        grouped[_period_start(day, grain)][day] = value
    result = []
    for start in sorted(grouped):
        end = _period_end(start, grain)
        days = (end - start).days + 1
        values = grouped[start]
        if len(values) != days or any(start + timedelta(days=i) not in values for i in range(days)):
            continue
        result.append({
            "start": start, "end": end, "days": days,
            "value": sum(values.values()),
            "negative": any(value < 0 for value in values.values()),
        })
    return result


def _factor_samples(
    periods: Sequence[Mapping[str, Any]], grain: str, target_start: date
) -> tuple[list[float], str]:
    """Build multiplier samples using only complete periods before target_start."""
    if grain == "day":
        eligible = [
            p for p in periods
            if p["start"] < target_start
            and (target_start - p["start"]).days <= 365
            and not p["negative"] and p["value"] >= 0
        ]
        by_start = {p["start"]: p for p in eligible}
        samples = []
        for current in eligible:
            if current["start"].weekday() != target_start.weekday():
                continue
            previous = by_start.get(current["start"] - timedelta(days=1))
            if previous is None or previous["negative"] or previous["value"] < 0:
                continue
            denominator, numerator = float(previous["value"]), float(current["value"])
            if denominator > 0 and numerator >= 0:
                samples.append(numerator / denominator)
        return samples, "目标周几历史单日 ÷ 紧邻前一完整日；仅非负日且正分母"

    if grain == "week":
        eligible = [
            p for p in periods
            if p["start"] < target_start
            and (target_start - p["start"]).days <= 7 * MAX_TRAIN_PERIODS["week"]
        ]
        by_start = {p["start"]: p for p in eligible}
        samples = []
        for current in eligible:
            previous = by_start.get(current["start"] - timedelta(days=7))
            if previous is None or previous["negative"] or current["negative"]:
                continue
            denominator, numerator = float(previous["value"]), float(current["value"])
            if denominator > 0 and numerator >= 0:
                samples.append(numerator / denominator)
        return samples, "相邻完整周周总量变化倍率；负值周期及非正分母剔除"

    eligible = [
        p for p in periods
        if p["start"] < target_start
        and (target_start - p["start"]).days <= 366 * MAX_TRAIN_PERIODS["month"] // 12
    ]
    by_start = {p["start"]: p for p in eligible}
    samples = []
    for current in eligible:
        if current["start"].month != target_start.month:
            continue
        previous = by_start.get(_month_start(current["start"] - timedelta(days=1)))
        if previous is None or previous["negative"] or current["negative"]:
            continue
        denominator = float(previous["value"]) / int(previous["days"])
        numerator = float(current["value"]) / int(current["days"])
        if denominator > 0 and numerator >= 0:
            samples.append(numerator / denominator)
    return samples, "同月份历史日均 ÷ 上一完整月日均；负值周期及非正分母剔除"


def _quantile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        raise ValueError("quantile needs at least one value")
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    part = position - low
    return ordered[low] * (1 - part) + ordered[high] * part


def _summary_metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    valid = [
        row for row in rows
        if row.get("status") == "ok" and row.get("predicted") is not None
        and row.get("baseline") is not None and row.get("actual") is not None
    ]
    denominator = sum(abs(float(row["actual"])) for row in valid)
    if not valid:
        return {
            "test_samples": 0, "wape": None, "baseline_wape": None,
            "bias": None, "improvement": None,
            "evaluation_status": "insufficient_backtest",
        }
    if denominator == 0:
        return {
            "test_samples": len(valid), "wape": None, "baseline_wape": None,
            "bias": None, "improvement": None,
            "evaluation_status": "zero_actual_denominator",
        }
    error = sum(abs(float(row["predicted"]) - float(row["actual"])) for row in valid)
    base_error = sum(abs(float(row["baseline"]) - float(row["actual"])) for row in valid)
    base_wape = base_error / denominator
    wape = error / denominator
    bias = sum(float(row["predicted"]) - float(row["actual"]) for row in valid) / denominator
    return {
        "test_samples": len(valid), "wape": wape, "baseline_wape": base_wape,
        "bias": bias,
        "improvement": (base_wape - wape) / base_wape if base_wape > 0 else None,
        "evaluation_status": "ok" if base_wape > 0 else "zero_baseline_wape",
    }


def _previous_period_has_negative(daily: Mapping[date, float], target_start: date, grain: str) -> bool:
    previous_start = _previous_start(target_start, grain)
    count = _period_days(previous_start, grain)
    return any(
        daily.get(previous_start + timedelta(days=i), 0.0) < 0
        for i in range(count)
    )


def _latest_target(
    grain: str, as_of: date, last_observation: date, daily: Mapping[date, float],
    *, metric: str | None = None, small_end: date | None = None,
) -> tuple[date | None, date | None, float | None, str, dict[str, Any] | None]:
    if grain == "day":
        target_start, previous_start = as_of + timedelta(days=1), as_of
    else:
        current_start = _period_start(as_of, grain)
        current_end = _period_end(current_start, grain)
        elapsed = (min(as_of, current_end) - current_start).days + 1
        observed = [
            daily[current_start + timedelta(days=i)] for i in range(elapsed)
            if current_start + timedelta(days=i) in daily
        ]
        current_complete = as_of == current_end and len(observed) == _period_days(current_start, grain)
        if not current_complete:
            label = "周" if grain == "week" else "月"
            note = (
                f"截至全局口径日期 {as_of.isoformat()}，当前{label}"
                f"（{current_start.isoformat()} 至 {current_end.isoformat()}）不完整；"
                f"本序列已观察 {len(observed)}/{elapsed} 个已过日期。"
                f"当前累计仅为已观察值合计，缺日未补零；暂无下一完整{label}预测。"
            )
            if metric == "小订数量" and small_end is None:
                note += " 小订未来目标期需确认仍处于小订期；缺少小订结束日期，未生成估计。"
            return None, None, None, note, {
                "start": current_start, "end": current_end,
                "observed_through": last_observation, "observed_days": len(observed),
                "expected_elapsed_days": elapsed, "partial_sum": sum(observed),
                "status": "incomplete_to_date",
            }
        target_start, previous_start = _next_start(current_start, grain), current_start

    target_end = _period_end(target_start, grain)
    if metric == "小订数量":
        if small_end is None:
            return None, None, None, (
                "小订未来目标期需确认仍处于小订期；缺少小订结束日期，未生成估计。"
            ), None
        if target_end > small_end:
            return None, None, None, (
                f"小订未来目标期 {target_start.isoformat()} 至 {target_end.isoformat()} "
                f"超出已确认的小订结束日 {small_end.isoformat()}，未生成估计。"
            ), None
    previous_days = _period_days(previous_start, grain)
    expected = [previous_start + timedelta(days=i) for i in range(previous_days)]
    if not all(day in daily for day in expected):
        if grain == "day":
            note = (
                f"目标日为 {target_start.isoformat()}，但本序列未观察到紧邻前一日 "
                f"{as_of.isoformat()}；缺日不补零，无法建立最近日基准。"
            )
        else:
            note = (
                f"上一周期 {previous_start.isoformat()} 至 {_period_end(previous_start, grain).isoformat()} "
                "缺少本序列日期观测；缺日不补零，无法建立下一完整周期基准。"
            )
        return target_start, target_end, None, note, None

    total = sum(float(daily[day]) for day in expected)
    baseline = total / previous_days * _period_days(target_start, grain)
    note = f"本序列最后观测日为 {last_observation.isoformat()}；目标期 {target_start.isoformat()} 至 {target_end.isoformat()}。"
    if last_observation < as_of:
        note += f"该序列最后观测早于三口径全局日期 {as_of.isoformat()}；需留意数据滞后。"
    return target_start, target_end, baseline, note, None


def build_forecast_insights(
    panel: Iterable[Mapping[str, Any]], calendar: Any = None, log: Any = None
) -> dict[str, Any]:
    """Return profiles, bounded rolling backtests, method definitions, and caveats.

    Holidays remain in natural-period totals and backtests. Calendar is accepted
    for API compatibility; no two-sided holiday comparison becomes a factor.
    """
    del calendar
    grouped: dict[tuple[str, str, str, str, str], dict[date, float]] = defaultdict(lambda: defaultdict(float))
    small_end_by_series: dict[tuple[str, str, str, str, str], set[date]] = defaultdict(set)
    observed_dates: list[date] = []
    skipped_bad = 0
    skipped_small_stage = 0
    for row in panel:
        if not isinstance(row, Mapping):
            continue
        metric = str(row.get("metric") or "")
        if metric not in TARGET_METRICS:
            continue
        # The forecast input is independently validated rather than trusting
        # only the daily reader.  Small-order observations outside the source
        # small-order phase are never silently reclassified or pooled.
        if metric == "小订数量" and str(row.get("stage") or "").strip() != "小订阶段":
            skipped_small_stage += 1
            continue
        day = _as_date(row.get("date"))
        try:
            value = float(row.get("value"))
        except (TypeError, ValueError):
            skipped_bad += 1
            continue
        if day is None or not isfinite(value):
            skipped_bad += 1
            continue
        key = _series_key(row)
        grouped[key][day] += value
        if metric == "小订数量":
            small_end = _as_date(
                row.get("small_end") or row.get("小订结束") or row.get("small_order_end")
            )
            if small_end is not None:
                small_end_by_series[key].add(small_end)
        observed_dates.append(day)

    as_of = max(observed_dates) if observed_dates else None
    if as_of is None:
        empty_notes = [
            "未找到源指标严格等于“小订数量”“留存大定”或“交车锁单”的有效日期数值行。",
            "没有用普通大定或其他锁单指标替代缺失口径。",
            "小订预测只接受 stage=小订阶段；其他阶段的小订记录已排除。",
        ]
        if skipped_small_stage:
            empty_notes.append(f"跳过 {skipped_small_stage} 条小订记录：阶段不是小订阶段。")
        if skipped_bad:
            empty_notes.append(f"跳过 {skipped_bad} 条目标指标记录：日期或数值无效。")
        return {
            "as_of": None, "profiles": [], "backtests": [],
            "method": {
                "objective": "以历史规律辅助销量预测，并分别评估小订、留存大定与交车锁单。",
                "calendar_used_for_factors": False,
            },
            "notes": empty_notes,
        }

    profiles: list[dict[str, Any]] = []
    backtests: list[dict[str, Any]] = []
    for key, daily in sorted(grouped.items(), key=lambda item: item[0]):
        model, metric, stage, cycle, source = key
        last_observation = max(daily)
        small_end_values = small_end_by_series.get(key, set())
        small_end = next(iter(small_end_values)) if len(small_end_values) == 1 else None
        for grain in GRAINS:
            grain_label={"day":"日","week":"周","month":"月"}[grain]
            periods = _complete_periods(daily, grain)
            if not periods:
                profiles.append({
                    "model": model, "metric": metric, "stage": stage, "cycle": cycle,
                    "source": source, "grain": grain, "as_of": as_of,
                    "last_observation": last_observation, "cutoff": as_of,
                    "target_start": None, "target_end": None, "baseline": None,
                    "estimate": None, "factor": None, "p25": None, "p75": None,
                    "train_samples": 0, "test_samples": 0, "wape": None,
                    "baseline_wape": None, "bias": None, "improvement": None,
                    "evaluation_status": "insufficient_backtest",
                    "status": "insufficient_history", "method": "没有完整历史周期",
                    "tail_status": "no_complete_period",
                    "tail_note": f"截至 {as_of.isoformat()} 未找到本序列完整{grain_label}周期；缺日未补零。",
                    "current_to_date": None,
                })
                continue

            starts = [p["start"] for p in periods]
            by_start = {p["start"]: p for p in periods}
            this_series_tests: list[dict[str, Any]] = []
            for target in periods[-MAX_BACKTEST_WINDOWS[grain]:]:
                start = target["start"]
                previous = by_start.get(_previous_start(start, grain))
                baseline = None if previous is None else float(previous["value"]) / int(previous["days"]) * int(target["days"])
                index = bisect_left(starts, start)
                train = periods[max(0, index - MAX_TRAIN_PERIODS[grain]):index]
                factors, factor_method = _factor_samples(train, grain, start)
                enough = len(factors) >= MIN_FACTOR_SAMPLES[grain]
                factor = float(median(factors)) if enough else None
                p25, p75 = (_quantile(factors, .25), _quantile(factors, .75)) if enough else (None, None)
                if baseline is None:
                    bt_status, predicted = "insufficient_history", None
                elif not enough:
                    bt_status, predicted = "insufficient_history", None
                elif previous is not None and previous["negative"]:
                    bt_status, predicted = "negative_baseline", None
                else:
                    bt_status, predicted = "ok", baseline * factor
                origin = start - timedelta(days=1)
                this_series_tests.append({
                    "model": model, "metric": metric, "stage": stage,
                    "cycle": cycle, "source": source, "grain": grain,
                    "origin": origin, "cutoff": origin,
                    "target_start": start, "target_end": target["end"],
                    "predicted": predicted, "baseline": baseline,
                    "actual": float(target["value"]), "actual_has_negative": bool(target["negative"]), "factor": factor,
                    "p25": p25, "p75": p75, "train_samples": len(factors),
                    "status": bt_status, "method": factor_method,
                })
            backtests.extend(this_series_tests)
            summary = _summary_metrics(this_series_tests)

            target_start, target_end, baseline, tail_note, current_to_date = _latest_target(
                grain, as_of, last_observation, daily,
                metric=metric, small_end=small_end,
            )
            factor = p25 = p75 = None
            train_samples = 0
            method = {
                "day": "周几历史倍率：过去一年同周几典型日值 ÷ 同窗非负日值中位数",
                "week": "周变化倍率：过去相邻完整周周总量比",
                "month": "月度转换倍率：同月份历史日均 ÷ 上一完整月日均",
            }[grain]
            status, estimate = "no_complete_target_period", None
            if target_start is not None:
                index = bisect_left(starts, target_start)
                train = periods[max(0, index - MAX_TRAIN_PERIODS[grain]):index]
                factors, factor_note = _factor_samples(train, grain, target_start)
                train_samples = len(factors)
                if train_samples >= MIN_FACTOR_SAMPLES[grain]:
                    factor = float(median(factors))
                    p25, p75 = _quantile(factors, .25), _quantile(factors, .75)
                else:
                    method = factor_note + f"；有效倍率样本 {train_samples}/{MIN_FACTOR_SAMPLES[grain]}"
                if baseline is None:
                    status = "insufficient_history"
                    tail_note += " 紧邻上一周期缺日或不完整，未建立基准。"
                elif factor is None:
                    status = "insufficient_history"
                    tail_note += f" 历史倍率仅 {train_samples} 个有效样本，规则估计留空。"
                elif _previous_period_has_negative(daily, target_start, grain):
                    status = "insufficient_history"
                    tail_note += " 最近基准周期含负值日，保留基准但不应用倍率。"
                else:
                    estimate, status = baseline * factor, "ok"
                if status == "ok" and summary["test_samples"] < MIN_BACKTEST_SAMPLES[grain]:
                    status = "insufficient_backtest"
                    tail_note += (
                        f" 规则估计可供试算，但有效滚动回测仅 {summary['test_samples']} 个窗口，"
                        f"少于最低展示要求 {MIN_BACKTEST_SAMPLES[grain]} 个。"
                    )
            else:
                method += "；当前自然周期未完整，暂不生成下一完整周期预测。"

            tail_status = (
                "current_period_incomplete"
                if target_start is None and grain in ("week", "month")
                else "series_lags_as_of" if last_observation < as_of
                else "ok" if target_start is not None else "no_target_baseline"
            )
            profiles.append({
                "model": model, "metric": metric, "stage": stage, "cycle": cycle,
                "source": source, "grain": grain, "as_of": as_of,
                "last_observation": last_observation, "cutoff": as_of,
                "target_start": target_start, "target_end": target_end,
                "baseline": baseline, "estimate": estimate, "factor": factor,
                "p25": p25, "p75": p75, "train_samples": train_samples,
                "test_samples": summary["test_samples"], "wape": summary["wape"],
                "baseline_wape": summary["baseline_wape"], "bias": summary["bias"],
                "improvement": summary["improvement"],
                "evaluation_status": summary["evaluation_status"],
                "status": status, "method": method, "tail_status": tail_status,
                "tail_note": tail_note, "current_to_date": current_to_date,
            })

    notes = [
        "只纳入源指标“小订数量”“留存大定”和“交车锁单”；严格按model/metric/stage/cycle/source分序列。小订数量只来自小订阶段，不以普通大定或另一锁单口径替代缺失。",
        "三种口径分别建立日、周、月预测辅助序列；小订仅在小订阶段建模。每种粒度使用完整自然周期；任一日期缺失时该自然周期不完整，缺日不补零。",
        "基准=紧邻上一完整周期日均×目标周期天数。规则倍率只使用目标期之前的完整样本，按最近有限窗口滚动回测。",
        "WAPE=sum(abs(估计-实际))/sum(abs(实际))；bias=sum(估计-实际)/sum(abs(实际))；improvement=(baseline_wape-wape)/baseline_wape。均为比例，正improvement表示相对改善；分母为零时为空并注明evaluation_status。",
        "P25/P75是有效历史倍率的经验分位范围，不是预测置信区间。倍率训练排除含负值周期及非正分母；负值实际仍留在周期合计与回测实际中。",
        "节假日观测保留在自然周期汇总与回测中；双侧节假日对照不作为未来预测因子，当前没有节日修正。",
        "周/月若as_of落在未完整的当前周期，则不生成下一完整周期预测；current_to_date只合计已观察值，缺日未补零。",
        "每序列每粒度最多回测最近day=56、week=26、month=24个完整目标周期；test_samples为规则模型与基准在同一窗口都可计算的数量；少于day=8、week=4、month=2个有效窗口时不标记已验证。",
    ]
    if skipped_bad:
        notes.append(f"跳过 {skipped_bad} 条目标指标记录：日期或数值无效。")
    if skipped_small_stage:
        notes.append(f"跳过 {skipped_small_stage} 条小订记录：阶段不是小订阶段。")
    if log:
        log(f"预测辅助规律完成：三口径（小订、留存大定、锁单）×日/周/月；序列{len(grouped)}组，profiles={len(profiles)}，backtests={len(backtests)}，as_of={as_of.isoformat()}，跳过小订阶段外记录{skipped_small_stage}条")
    return {
        "as_of": as_of, "profiles": profiles, "backtests": backtests,
        "method": {
            "objective": "以可解释历史规律辅助销量预测，并以严格滚动回测比较最近周期基准。",
            "metrics": ["小订数量", "留存大定", "交车锁单"], "grains": list(GRAINS),
            "as_of_scope": "三个目标指标中有效观测日期的全局最大日期",
            "calendar_used_for_factors": False,
            "factor_interval": "P25/P75是历史倍率经验范围，不是预测置信区间",
            "improvement_definition": "(baseline_wape-wape)/baseline_wape；正值表示相对改善",
            "backtest_window_limits": dict(MAX_BACKTEST_WINDOWS),
            "minimum_factor_samples": dict(MIN_FACTOR_SAMPLES),
            "minimum_backtest_samples": dict(MIN_BACKTEST_SAMPLES),
            "wape_definition": "sum(abs(predicted-actual))/sum(abs(actual))",
            "bias_definition": "sum(predicted-actual)/sum(abs(actual))",
        },
        "notes": notes,
    }
