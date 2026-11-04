"""Descriptive, time-split rule summaries built only from analyzer results."""
from __future__ import annotations
import calendar
import math
import re
from collections import defaultdict
from datetime import date, datetime
from numbers import Real
from statistics import median

ALL_MODELS = "全部车型"
FIELDS = ("category", "metric", "stage", "pattern", "typical", "p25", "p75",
          "models", "samples", "periods", "years", "conclusion", "train_ratio",
          "validation_year", "validation_ratio", "validation_status", "validation_note", "unit", "detail_sheet",
          "validation_models", "validation_train_years")


def _date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value is not None else None
    except (TypeError, ValueError):
        return None


def _num(value):
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _quantile(values, p):
    values = sorted(values)
    if not values:
        return None
    pos = (len(values) - 1) * p
    lo = int(pos)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (pos - lo)


def _key(row):
    return (str(row.get("model", "")), row.get("metric"), row.get("stage"),
            row.get("cycle"), row.get("source"))


def _negative_free(row):
    return all(_num(row.get(field, 0)) == 0 for field in
               ("current_negative_days", "previous_negative_days"))


def _validation_year(results):
    ends = [_date(row.get("end")) for row in results.get("coverage", [])]
    ends = [d for d in ends if d]
    if not ends:
        return None
    end = max(ends)
    return end.year if (end.month, end.day) == (12, 31) else end.year - 1


def _complete_years(results):
    complete = defaultdict(set)
    for row in results.get("period_comparisons", []):
        if row.get("kind") != "年" or _num(row.get("current_negative_days", 0)) != 0:
            continue
        current = _num(row.get("current"))
        if current is None or current < 0:
            continue
        start, end = _date(row.get("start")), _date(row.get("end"))
        if not start or not end or start != date(start.year, 1, 1) or end != date(start.year, 12, 31):
            continue
        days = 366 if calendar.isleap(start.year) else 365
        if row.get("current_days") == days and row.get("current_observed") == days:
            complete[_key(row)].add(start.year)
    return complete


def _aggregate(samples):
    if not samples:
        return dict(typical=None, p25=None, p75=None, models=0, samples=0, periods=0, years=0)
    by_model, period_models, years = defaultdict(list), defaultdict(lambda: defaultdict(list)), set()
    for item in samples:
        by_model[item["key"][0]].append(item["value"])
        period_models[item["period"]][item["key"][0]].append(item["value"])
        years.add(item["year"])
    per_period = [median(median(v) for v in models.values())
                  for models in period_models.values() if models]
    return dict(typical=median(median(v) for v in by_model.values()),
                p25=_quantile(per_period, .25), p75=_quantile(per_period, .75),
                models=len(by_model),
                samples=sum(len(models) for models in period_models.values()),
                periods=len(period_models), years=len(years))


def _direction(value):
    return 1 if value > 1 else -1 if value < 1 else 0


def _validate(samples, year):
    if year is None:
        return None, None, "无完整年度可验证", ""
    hold = [s for s in samples if s["year"] == year]
    if not hold:
        return None, None, "未覆盖完整年度", ""
    train = [s for s in samples if s["year"] < year]
    keys = {s["key"] for s in train} & {s["key"] for s in hold}
    if not keys:
        return None, None, "样本不足（缺少同车型、批次、来源的训练期）", ""
    train_models, hold_models, train_years = defaultdict(list), defaultdict(list), set()
    for s in train:
        if s["key"] in keys:
            train_models[s["key"][0]].append(s["value"])
            train_years.add(s["year"])
    for s in hold:
        if s["key"] in keys:
            hold_models[s["key"][0]].append(s["value"])
    models = set(train_models) & set(hold_models)
    if not models:
        return None, None, "样本不足（缺少同车型验证样本）", ""
    train_ratio = median(median(train_models[m]) for m in models)
    validation_ratio = median(median(hold_models[m]) for m in models)
    status = "同向" if _direction(train_ratio) == _direction(validation_ratio) else "不同向"
    note = f"{len(models)}个车型、{len(train_years)}个训练完整年度；仅作方向对照，不代表统计显著。"
    return train_ratio, validation_ratio, status, note


def _conclusion(item):
    if item["typical"] is None:
        text = ("无合格样本：未覆盖完整年度。" if item["validation_status"] == "未覆盖完整年度"
                else "无合格样本：暂不能判断该项规律。")
        note = item.get("validation_note")
        return text + (f"留出验证提示：{note}" if note else "")
    if item["periods"] < 3 or item["models"] < 2:
        base = (f"样本不足：{item['models']}个车型、{item['periods']}个不同日历周期；"
                "仅作描述，暂不归纳组级通用方向。")
    else:
        direction = "高于持平" if item["typical"] > 1 else "低于持平" if item["typical"] < 1 else "等于持平"
        base = f"车型等权中位数为{item['typical']:.1%}，{direction}；仅为描述性汇总，不代表统计显著。"
    verify = item["validation_status"]
    if verify in ("同向", "不同向"):
        note = item.get("validation_note") or "仅作方向对照，不代表统计显著"
        return base + f"留出验证为{verify}（{note}）"
    return base + ("留出验证样本不足。" if verify != "未覆盖完整年度"
                   else "留出年度未达到完整覆盖要求。")


def _launch_conclusion(item):
    """Describe launch pacing without implying cross-batch validation."""
    if item["typical"] is None:
        base = "无合格样本：上市后周期缺少完整可比数据。"
    elif item["periods"] < 3 or item["models"] < 2:
        base = (f"样本不足：{item['models']}个车型、{item['periods']}个不同上市起始日期；"
                "仅作描述，暂不归纳组级通用方向。")
    else:
        direction = "高于持平" if item["typical"] > 1 else "低于持平" if item["typical"] < 1 else "等于持平"
        base = f"相邻周期日均比的车型等权中位数为{item['typical']:.1%}，{direction}；仅为描述性汇总。"
    return base + "上市批次描述，首销、跨阶段和平销分别汇总；未做跨批次留出验证。"


def _launch_pattern_order(pattern):
    match = re.search(r"第(\d+)(周|月)", pattern)
    return (0 if match and match[2] == "周" else 1,
            int(match[1]) if match else 0, pattern)


def build_rule_summary(results, model_map, categories, selected_metrics=None):
    """Build ratios with model-equal weighting and full-year same-key holdout checks."""
    results = results or {}
    model_map = {str(k): (v or {}) for k, v in (model_map or {}).items()}
    metric_filter = ({selected_metrics} if isinstance(selected_metrics, str)
                     else set(selected_metrics) if selected_metrics is not None else None)
    categories = list(dict.fromkeys(str(c) for c in (categories or []) if c is not None and str(c)))
    categories = [c for c in categories if c != ALL_MODELS]
    if not categories:
        categories = sorted({v.get("category") for v in model_map.values() if v.get("category")})
    val_year, complete = _validation_year(results), _complete_years(results)
    weekly = list(results.get("weekly", []) or [])
    monthly = list(results.get("monthly", []) or [])
    annual = list(results.get("annual", []) or [])
    holidays = list(results.get("holidays", []) or [])
    comps = list(results.get("period_comparisons", []) or [])
    launch_rows = list(results.get("launch_pacing", []) or [])
    all_rows = weekly + monthly + annual + holidays + comps
    combos = {(str(r["model"]), r["metric"], r["stage"]) for r in all_rows
              if r.get("model") is not None and r.get("metric") is not None and r.get("stage") is not None
              and (metric_filter is None or r.get("metric") in metric_filter)}
    scopes = set()
    for model, metric, stage in combos:
        scopes.add((ALL_MODELS, metric, stage))
        cat = model_map.get(model, {}).get("category")
        if cat in categories:
            scopes.add((cat, metric, stage))
    known_pairs = {(metric, stage) for _, metric, stage in combos}
    for cov in results.get("coverage", []) or []:
        metric, stage = cov.get("metric"), cov.get("stage")
        if (metric is not None and stage is not None and (metric, stage) not in known_pairs
                and (metric_filter is None or metric in metric_filter)):
            # Coverage-only results can explain a missing overall pattern, but
            # must not fabricate every category × metric × stage combination.
            scopes.add((ALL_MODELS, metric, stage))

    launch_specs = set()
    for row in launch_rows:
        metric, stage, pattern = row.get("metric"), row.get("stage"), row.get("pattern")
        if (metric is None or stage is None or pattern is None or
                (metric_filter is not None and metric not in metric_filter)):
            continue
        launch_specs.add((ALL_MODELS, metric, stage, str(pattern)))
        category = model_map.get(str(row.get("model", "")), {}).get("category")
        if category in categories:
            launch_specs.add((category, metric, stage, str(pattern)))

    holiday_names = sorted({str(r["holiday"]) for r in holidays if r.get("holiday")})
    specs = []
    for cat, metric, stage in sorted(scopes, key=lambda x: (x[0], str(x[1]), str(x[2]))):
        specs.extend([(cat, metric, stage, "周末/工作日（日均）", "周内明细", "week"),
                      (cat, metric, stage, "月末7天/其余日期（日均）", "月内明细", "monthend")])
        specs.extend((cat, metric, stage, f"{m}月/上月（日均）", "月份证据", f"month:{m}") for m in range(1, 13))
        if stage == "平销":
            specs.extend((cat, metric, stage, f"{m}月年度季节指数", "年度季节性", f"annual:{m}") for m in range(1, 13))
        for h in holiday_names:
            specs.extend((cat, metric, stage, f"{h}{label}", "节假日明细", f"holiday:{h}:{field}")
                         for field, label in (("before", "节前"), ("during", "节中"), ("after", "节后")))

    def in_scope(r, cat, metric, stage):
        return (r.get("metric") == metric and r.get("stage") == stage and
                (cat == ALL_MODELS or model_map.get(str(r.get("model", "")), {}).get("category") == cat))

    def make_sample(r, value, period, year):
        value = _num(value)
        if value is None or value < 0 or year is None:
            return None
        # Descriptive summaries use every valid period, including partial years.
        # Completeness and the temporal cutoff are applied only to validation.
        return {"key": _key(r), "value": value, "period": period, "year": year}

    def by_metric_stage(rows):
        grouped = defaultdict(list)
        for row in rows:
            grouped[(row.get("metric"), row.get("stage"))].append(row)
        return grouped

    weekly_index = by_metric_stage(weekly)
    monthly_index = by_metric_stage(monthly)
    annual_index = by_metric_stage(annual)
    holiday_index = defaultdict(list)
    month_comparison_index = defaultdict(list)
    for row in holidays:
        holiday_index[(row.get("metric"), row.get("stage"), str(row.get("holiday")))].append(row)
    for row in comps:
        if row.get("kind") != "月" or row.get("status") != "有效" or not _negative_free(row):
            continue
        start = _date(row.get("start"))
        if start:
            month_comparison_index[(row.get("metric"), row.get("stage"), start.month)].append(row)

    output = []
    for cat, metric, stage, pattern, detail, kind in specs:
        values = []
        if kind == "week":
            for r in weekly_index.get((metric, stage), ()):
                if in_scope(r, cat, metric, stage):
                    d = _date(r.get("week"))
                    item = make_sample(r, r.get("ratio"), d, d.year if d else None)
                    if item:
                        values.append(item)
        elif kind == "monthend":
            for r in monthly_index.get((metric, stage), ()):
                if not in_scope(r, cat, metric, stage):
                    continue
                y, m = _num(r.get("year")), _num(r.get("month"))
                if y is not None and m is not None:
                    y, m = int(y), int(m)
                    item = make_sample(r, r.get("ratio"), (y, m), y)
                    if item:
                        values.append(item)
        elif kind.startswith("month:"):
            month_no = int(kind.split(":")[1])
            for r in month_comparison_index.get((metric, stage, month_no), ()):
                if not in_scope(r, cat, metric, stage):
                    continue
                d = _date(r.get("start"))
                if d and d.month == month_no:
                    item = make_sample(r, r.get("daily_ratio"), (d.year, d.month), d.year)
                    if item:
                        values.append(item)
        elif kind.startswith("annual:"):
            month_no = int(kind.split(":")[1])
            for r in annual_index.get((metric, stage), ()):
                if stage != "平销" or not in_scope(r, cat, metric, stage):
                    continue
                y, idx = _num(r.get("year")), r.get("indexes")
                if y is None or not isinstance(idx, (list, tuple)) or len(idx) != 12:
                    continue
                y = int(y)
                # Seasonal indexes require a complete-year evidence row.
                if y not in complete.get(_key(r), set()):
                    continue
                raw = _num(idx[month_no - 1])
                item = make_sample(r, raw / 100 if raw is not None else None, (y, month_no), y)
                if item:
                    values.append(item)
        else:
            _, holiday, phase = kind.split(":", 2)
            for r in holiday_index.get((metric, stage, holiday), ()):
                if stage != "平销" or not in_scope(r, cat, metric, stage):
                    continue
                y = _num(r.get("year"))
                y = int(y) if y is not None else None
                item = make_sample(r, r.get(phase), (y, holiday) if y is not None else None, y)
                if item:
                    values.append(item)

        summary = _aggregate(values)
        validation_values = [s for s in values
                             if val_year is not None and s["year"] <= val_year
                             and s["year"] in complete.get(s["key"], set())]
        train, validation, status, note = _validate(validation_values, val_year)
        train_keys = {s["key"] for s in validation_values if s["year"] < val_year}
        hold_keys = {s["key"] for s in validation_values if s["year"] == val_year}
        common_keys = train_keys & hold_keys
        validation_models = len({key[0] for key in common_keys})
        validation_train_years = len({s["year"] for s in validation_values
                                      if s["year"] < val_year and s["key"] in common_keys})
        summary.update(category=cat, metric=metric, stage=stage, pattern=pattern,
                       conclusion="", train_ratio=train, validation_year=val_year,
                       validation_ratio=validation, validation_status=status,
                       validation_note=note, unit="比例", detail_sheet=detail,
                       validation_models=validation_models, validation_train_years=validation_train_years)
        summary["conclusion"] = _conclusion(summary)
        output.append({field: summary.get(field) for field in FIELDS})

    # Launch pacing is a separate description family.  It is attached to the
    # existing lifecycle detail sheet and deliberately bypasses full-year
    # validation because each row describes a launch batch rather than a
    # recurring calendar period.
    for cat, metric, stage, pattern in sorted(launch_specs,
                                               key=lambda x: (x[0], str(x[1]), str(x[2]), _launch_pattern_order(x[3]))):
        values = []
        for row in launch_rows:
            if (row.get("pattern") != pattern or row.get("status") != "有效"
                    or not in_scope(row, cat, metric, stage)):
                continue
            cycle = _date(row.get("cycle"))
            if cycle is None:
                continue
            item = make_sample(row, row.get("daily_ratio", row.get("ratio")), cycle, cycle.year)
            if item:
                values.append(item)
        summary = _aggregate(values)
        summary.update(category=cat, metric=metric, stage=stage, pattern=pattern,
                       conclusion="", train_ratio=None, validation_year=None,
                       validation_ratio=None, validation_status="未做跨批次留出验证",
                       validation_note="上市批次描述；上市月按首销日逐月划分，使用日均比；未做跨批次留出验证",
                       unit="日均比例", detail_sheet="生命周期明细",
                       validation_models=0, validation_train_years=0)
        summary["conclusion"] = _launch_conclusion(summary)
        output.append({field: summary.get(field) for field in FIELDS})
    return output
