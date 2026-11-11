"""上市后销量节奏：首销及其后平销期的留存大定与锁单周期比较。

The module intentionally works on the already validated daily panel.  It does
not synthesize missing days. Models, launch batches and metrics stay separate;
source changes remain visible and cannot create a comparable ratio.
"""
from __future__ import annotations

import calendar
import math
from collections import defaultdict
from datetime import date, datetime, timedelta
from numbers import Real
from typing import Any, Iterable, Mapping


TARGET_METRICS = ("留存大定", "交车锁单")
DAILY_SHEET = "小订首销平销by天"
_GRAINS = ("周", "月")


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _valid_anchor(row: Mapping[str, Any]) -> tuple[date, date, int] | None:
    anchor = _as_date(row.get("cycle"))
    day = _as_date(row.get("date"))
    life_value = row.get("life")
    if anchor is None or day is None or life_value is None:
        return None
    if isinstance(life_value, str):
        text = life_value.strip().upper()
        if text.startswith("D"):
            text = text[1:]
        if not text.isdigit():
            return None
        life = int(text)
    else:
        if isinstance(life_value, bool):
            return None
        if isinstance(life_value, Real) and not float(life_value).is_integer():
            return None
        try:
            life = int(life_value)
        except (TypeError, ValueError):
            return None
    if life <= 0 or day != anchor + timedelta(days=life - 1):
        return None
    return anchor, day, life


# ---------------------------------------------------------------------------
# 上市后销量节奏：按上市日切分实际触及的周/月周期。

def _add_months(anchor: date, offset: int) -> date:
    index = anchor.year * 12 + anchor.month - 1 + offset
    year, month_index = divmod(index, 12)
    month = month_index + 1
    day = min(anchor.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _period_bounds(anchor: date, grain: str, period_no: int) -> tuple[date, date]:
    if grain == "周":
        start = anchor + timedelta(days=(period_no - 1) * 7)
        return start, start + timedelta(days=6)
    start = _add_months(anchor, period_no - 1)
    return start, _add_months(anchor, period_no) - timedelta(days=1)


def _period_no_for_day(anchor: date, day: date, grain: str) -> int | None:
    if day < anchor:
        return None
    if grain == "周":
        return (day - anchor).days // 7 + 1
    period_no = max(1, (day.year - anchor.year) * 12 + day.month - anchor.month + 1)
    while period_no > 1 and day < _period_bounds(anchor, grain, period_no)[0]:
        period_no -= 1
    while day > _period_bounds(anchor, grain, period_no)[1]:
        period_no += 1
    return period_no


def _period_stage(start: date, end: date, launch_end: date | None,
              observed_stages: set[str]) -> str:
    if launch_end is None:
        return "首销" if observed_stages <= {"首销"} else "跨阶段"
    if end <= launch_end:
        return "首销"
    if start > launch_end:
        return "平销"
    return "跨阶段"


def _normalise_panel(panel: Iterable[Mapping[str, Any]] | None):
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    seen: dict[tuple[str, str, str, date], dict[str, Any]] = {}
    for row in panel or ():
        if not isinstance(row, Mapping) or row.get("metric") not in TARGET_METRICS:
            continue
        if row.get("sheet") not in (None, "", DAILY_SHEET):
            continue
        raw_stage = str(row.get("stage") or "").strip()
        if raw_stage not in ("首销", "平销"):
            continue
        day = _as_date(row.get("date"))
        value = _number(row.get("value"))
        if day is None or value is None:
            continue
        launch_start = _as_date(row.get("launch_start"))
        launch_end = _as_date(row.get("launch_end"))
        # Old callers have only cycle/life.  A valid 首销 row can still be
        # aligned; a flat-sale row without metadata is deliberately skipped.
        if launch_start is None and raw_stage == "首销":
            old = _valid_anchor(row)
            if old is not None:
                launch_start = old[0]
        if launch_start is None or day < launch_start:
            continue
        if raw_stage == "平销" and (launch_end is None or day <= launch_end):
            continue
        effective_stage = "首销" if launch_end is None or day <= launch_end else "平销"
        model = str(row.get("model", ""))
        metric = str(row.get("metric", ""))
        cycle = launch_start.isoformat()
        group_key = (model, metric, cycle)
        duplicate_key = group_key + (day,)
        if duplicate_key in seen:
            raise ValueError("上市后节奏同一日重复，拒绝静默覆盖：" + repr(duplicate_key))
        item = dict(row)
        item.update(model=model, metric=metric, date=day, value=value,
                    launch_start=launch_start, launch_end=launch_end,
                    cycle=cycle, _stage=effective_stage,
                    source=str(row.get("source", "")))
        seen[duplicate_key] = item
        groups[group_key].append(item)
    return groups


def _period_record(rows: list[dict[str, Any]], anchor: date, grain: str,
               period_no: int, launch_end: date | None) -> dict[str, Any]:
    start, end = _period_bounds(anchor, grain, period_no)
    observed = sorted((row for row in rows if start <= row["date"] <= end),
                      key=lambda row: row["date"])
    values = [float(row["value"]) for row in observed]
    expected_days = (end - start).days + 1
    sources = sorted({row["source"] for row in observed})
    source_switch = len(sources) > 1
    source = sources[0] if len(sources) == 1 else "；".join(sources)
    observed_start = observed[0]["date"] if observed else None
    observed_end = observed[-1]["date"] if observed else None
    daily_avg = (sum(values) / expected_days
                 if len(observed) == expected_days and all(value >= 0 for value in values)
                 else None)
    first = rows[0]
    label = f"第{period_no}周期"
    return {
        "model": first.get("model", ""),
        "metric": first.get("metric"),
        "stage": _period_stage(start, end, launch_end,
                            {row["_stage"] for row in observed}),
        "cycle": anchor.isoformat(),
        "launch_start": anchor,
        "launch_end": launch_end,
        "sheet": first.get("sheet", DAILY_SHEET),
        "source": source,
        "sources": sources,
        "source_switch": source_switch,
        "brand": first.get("brand", "未提供"),
        "segment": first.get("segment", "未提供"),
        "energy": first.get("energy", "未提供"),
        "period": label,
        "period_label": label,
        "period_no": period_no,
        "grain": grain,
        "start": start,
        "end": end,
        "current": sum(values),
        "current_observed_total": sum(values),
        "observed": len(observed),
        "observed_start": observed_start,
        "observed_end": observed_end,
        "expected_days": expected_days,
        "daily_avg": daily_avg,
        "negative": any(value < 0 for value in values),
        "status": ("来源切换不可比" if source_switch else
                   "有效" if len(observed) == expected_days and all(value >= 0 for value in values)
                   else "本期含负值" if any(value < 0 for value in values)
                   else "本期缺失或不完整"),
    }


def _comparison(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    previous_value = previous["current"]
    current_value = current["current"]
    source_switch = (previous.get("source_switch") or current.get("source_switch") or
                     previous.get("sources", []) != current.get("sources", []))
    if source_switch:
        status = "来源切换不可比"
    elif current.get("negative"):
        status = "本期含负值"
    elif previous.get("negative"):
        status = "前期含负值"
    elif current["observed"] != current["expected_days"]:
        status = "本期缺失或不完整"
    elif previous["observed"] != previous["expected_days"]:
        status = "前期缺失或不完整"
    elif previous_value == 0:
        status = "前期为零"
    elif previous_value < 0:
        status = "前期为负"
    else:
        status = "有效"
    ratio = current_value / previous_value if status == "有效" else None
    daily_ratio = (current["daily_avg"] / previous["daily_avg"]
                   if status == "有效" and previous.get("daily_avg") not in (None, 0)
                   and current.get("daily_avg") is not None else None)
    grain = current["grain"]
    return {
        "model": current["model"],
        "metric": current["metric"],
        "stage": current["stage"] if previous["stage"] == current["stage"] else "跨阶段",
        "previous_stage": previous["stage"],
        "current_stage": current["stage"],
        "cycle": current["cycle"],
        "launch_start": current.get("launch_start"),
        "launch_end": current.get("launch_end"),
        "sheet": current.get("sheet", DAILY_SHEET),
        "source": current.get("source", ""),
        "previous_source": previous.get("source", ""),
        "current_source": current.get("source", ""),
        "previous_sources": previous.get("sources", []),
        "current_sources": current.get("sources", []),
        "brand": current.get("brand", "未提供"),
        "segment": current.get("segment", "未提供"),
        "energy": current.get("energy", "未提供"),
        "pattern": f"上市第{current['period_no']}{grain}/第{previous['period_no']}{grain}",
        "grain": grain,
        "period_no": current["period_no"],
        "previous_period_no": previous["period_no"],
        "start": current["start"],
        "end": current["end"],
        "previous_start": previous["start"],
        "previous_end": previous["end"],
        "current": current_value,
        "previous": previous_value,
        "ratio": ratio,
        "daily_ratio": daily_ratio,
        "current_observed": current["observed"],
        "previous_observed": previous["observed"],
        "observed_start": min(x for x in (previous.get("observed_start"), current.get("observed_start")) if x is not None),
        "observed_end": max(x for x in (previous.get("observed_end"), current.get("observed_end")) if x is not None),
        "previous_observed_start": previous.get("observed_start"),
        "previous_observed_end": previous.get("observed_end"),
        "current_observed_start": current.get("observed_start"),
        "current_observed_end": current.get("observed_end"),
        "current_days": current["expected_days"],
        "previous_days": previous["expected_days"],
        "current_expected_days": current["expected_days"],
        "previous_expected_days": previous["expected_days"],
        "status": status,
    }


def build_launch_analysis(panel: Iterable[Mapping[str, Any]] | None) -> dict[str, list[dict[str, Any]]]:
    """Return actual上市后周/月周期明细和相邻周期比较。"""
    groups = _normalise_panel(panel)
    periods: list[dict[str, Any]] = []
    comparisons: list[dict[str, Any]] = []
    for key, rows in groups.items():
        rows.sort(key=lambda row: row["date"])
        ends = {row["launch_end"] for row in rows}
        if len(ends) > 1:
            raise ValueError("上市批次首销结束日期冲突，无法静默合并：" + repr(key))
        anchor = rows[0]["launch_start"]
        launch_end = next(iter(ends)) if ends else None
        by_grain: dict[str, list[dict[str, Any]]] = {grain: [] for grain in _GRAINS}
        for grain in _GRAINS:
            period_numbers = sorted({number for row in rows
                                     if (number := _period_no_for_day(anchor, row["date"], grain)) is not None})
            for period_no in period_numbers:
                record = _period_record(rows, anchor, grain, period_no, launch_end)
                by_grain[grain].append(record)
                periods.append(record)
            for previous, current in zip(by_grain[grain], by_grain[grain][1:]):
                if current["period_no"] == previous["period_no"] + 1:
                    comparisons.append(_comparison(previous, current))
    periods.sort(key=lambda row: (row["model"], row["metric"], row["cycle"],
                                  row["grain"], row["period_no"]))
    comparisons.sort(key=lambda row: (row["model"], row["metric"], row["cycle"],
                                      row["grain"], row["period_no"]))
    return {"periods": periods, "comparisons": comparisons}


def build_launch_pacing(panel: Iterable[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Compatibility entry returning the new上市后相邻周期 comparisons."""
    return build_launch_analysis(panel)["comparisons"]


analyze_launch_pacing = build_launch_pacing
analyze_launch = build_launch_analysis

__all__ = ["TARGET_METRICS", "build_launch_analysis", "build_launch_pacing",
           "analyze_launch", "analyze_launch_pacing"]
