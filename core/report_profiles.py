"""Model grouping, monthly profiles and headline findings for the sales report."""
import math
from collections import defaultdict
from statistics import mean, median


def _groups(rows, keys):
    result = defaultdict(list)
    for row in rows:
        result[tuple(row.get(k) for k in keys)].append(row)
    return list(result.items())


def _within(rows, field):
    values = []
    for _, model_rows in _groups(rows, ["model"]):
        nums = [r.get(field) for r in model_rows if r.get(field) is not None]
        if nums:
            values.append(median(nums))
    return median(values) if values else None


def _choose_grouping(models, config):
    dimensions = [("segment", "产品档位"), ("brand", "品牌"), ("energy", "能源类型")]
    group_by = config.get("groupBy", "auto")
    min_groups = config.get("minGroups", 3)
    max_groups = config.get("maxGroups", 8)
    if not isinstance(min_groups, int) or not isinstance(max_groups, int) or min_groups < 1 or max_groups < min_groups:
        raise ValueError("分组数量范围无效")
    if group_by != "auto" and group_by not in {x[0] for x in dimensions}:
        raise ValueError("groupBy须为auto、segment、brand或energy")
    candidates = []
    for priority, (key, label) in enumerate(dimensions):
        valid = [str(r.get(key) or "").strip() for r in models]
        valid = [x for x in valid if x and x not in {"未提供", "映射冲突"}]
        count = len(set(valid))
        coverage = len(valid) / len(models) if models else 0
        candidates.append(dict(key=key, label=label, priority=priority, count=count,
                               coverage=coverage, fit=min_groups <= count <= max_groups))
    complete = [r for r in candidates if r["coverage"] >= .8 and r["count"] > 1]
    pool = complete or candidates
    if group_by == "auto":
        selected = sorted(pool, key=lambda x: (-int(x["fit"]), -x["coverage"], x["priority"]))[0]
    else:
        selected = next(r for r in candidates if r["key"] == group_by)
    entries = []
    for row in models:
        item = dict(row)
        value = str(row.get(selected["key"]) or "").strip() or "未提供"
        item["category"] = f'{selected["label"]}：{value}'
        entries.append(item)
    categories = sorted({r["category"] for r in entries})
    reason = (
        ("自动选择" if group_by == "auto" else "配置指定") + f' {selected["label"]}；'
        f'有效属性覆盖 {selected["coverage"] * 100:.1f}%；原始类别 {selected["count"]} 个；缺失/冲突独立展示'
    )
    return dict(entries=entries, categories=categories, candidates=candidates, reason=reason)


def _selected_metrics(comparisons, config=None):
    available = list(dict.fromkeys(r["metric"] for r in comparisons))
    available.sort(key=lambda metric: ({"小订数量": 0, "留存大定": 1, "交车锁单": 2}.get(metric, 3), metric))
    requested = (config or {}).get("mainMetrics", "auto")
    if requested == "auto":
        return available, []
    if not isinstance(requested, list) or not requested or any(not isinstance(x, str) for x in requested):
        raise ValueError("mainMetrics须为auto或非空指标名称列表")
    unknown = [x for x in requested if x not in available]
    if unknown:
        raise ValueError("mainMetrics指定的指标在本次数据中不存在：" + "、".join(unknown))
    return list(dict.fromkeys(requested)), [x for x in available if x not in requested]


def _report_series(comparisons, categories, model_map, selected_metrics=None):
    allowed = set(selected_metrics) if selected_metrics is not None else {r["metric"] for r in comparisons}
    buckets = defaultdict(dict)
    for row in comparisons:
        if row["metric"] not in allowed:
            continue
        key = (row["metric"], row["stage"])
        category = model_map.get(row["model"], {}).get("category")
        buckets["全部车型"][key] = None
        if category is not None:
            buckets[category][key] = None
    return [dict(category=category, metric=metric, stage=stage)
            for category in ["全部车型", *categories] for metric, stage in buckets[category]]


def build_monthly_profiles(results, series, model_map):
    """Summarize complete calendar months and adjacent-month comparisons."""
    def pick(rows, category, metric, stage):
        return [r for r in rows if (category == "全部车型" or model_map.get(r.get("model"), {}).get("category") == category)
                and r.get("metric") == metric and r.get("stage") == stage]

    month_rows = [r for r in results.get("period_comparisons", []) if r.get("kind") == "月"]
    monthly_profiles = []
    for item in series:
        scoped = pick(month_rows, item["category"], item["metric"], item["stage"])
        for month in range(1, 13):
            rows = [r for r in scoped if str(r.get("start", ""))[5:7] == f"{month:02d}"]
            complete = [dict(r, daymean=r["current"] / r["current_days"]) for r in rows
                        if r.get("current_observed") == r.get("current_days") and r.get("current_negative_days", 0) == 0
                        and r.get("current", -1) >= 0 and r.get("current_days", 0) > 0]
            paired = [r for r in rows if r.get("status") == "有效"]
            years = sorted({str(r.get("start", ""))[:4] for r in paired})
            annual = [(year, _within([r for r in paired if str(r.get("start", "")).startswith(year)], "daily_ratio")) for year in years]
            if not paired:
                conclusion = "缺少完整相邻月"
            elif len(years) < 2:
                conclusion = "单年样本，不能认定季节性"
            elif all(v is not None and v > 1 for _, v in annual):
                conclusion = "各年中位数均上升，待控制活动"
            elif all(v is not None and v < 1 for _, v in annual):
                conclusion = "各年中位数均下降，待控制活动"
            else:
                conclusion = "跨年方向不一致"
            monthly_profiles.append(dict(
                **item, month=month, daymean=_within(complete, "daymean"), ratio=_within(paired, "ratio"),
                daily=_within(paired, "daily_ratio"), models=len({r["model"] for r in complete}),
                complete=len(complete), pairs=len(paired), pairmodels=len({r["model"] for r in paired}),
                years=len(years), periods=len({r.get("start") for r in paired}),
                above=mean([mean([1 if r.get("daily_ratio") is not None and r["daily_ratio"] > 1 else 0 for r in rs])
                            for _, rs in _groups(paired, ["model"])]) if paired else None,
                yearly="；".join(f"{year}：{value * 100:.1f}%" for year, value in annual if value is not None),
                conclusion=conclusion
            ))
    return monthly_profiles


def _headline_findings(rules):
    """Put forecast targets first; describe observed direction without overstating it."""
    focus = [r for r in rules if r.get("metric") in ("小订数量", "留存大定", "交车锁单")
             and isinstance(r.get("typical"), (int, float)) and math.isfinite(r["typical"])]
    overall = [r for r in focus if r.get("category") == "全部车型"]
    focus = overall or focus
    result = []
    for row in focus:
        r = dict(row)
        enough = r.get("models", 0) >= 2 and r.get("periods", 0) >= 3
        direction = lambda value: 1 if value > 1 else -1 if value < 1 else 0
        train, hold = r.get("train_ratio"), r.get("validation_ratio")
        across_years = (enough and r.get("years", 0) >= 2 and r.get("validation_status") == "同向"
                        and r.get("validation_models", 0) >= 2 and r.get("validation_train_years", 0) >= 1
                        and train is not None and hold is not None
                        and direction(train) == direction(hold) == direction(r["typical"]))
        p25, p75 = r.get("p25"), r.get("p75")
        stable = p25 is not None and p75 is not None and (p25 > 1 or p75 < 1 or p25 == p75 == 1)
        r["cross_year_candidate"] = across_years
        if not enough:
            status = "样本不足，仅作描述"
        elif across_years:
            status = f"跨年同向候选；共同验证{r['validation_models']}车型、{r['validation_train_years']}个训练年；仍须回测"
        elif stable:
            status = "样本内方向较一致，待跨年验证"
        else:
            status = "历史周期有波动，待验证"
        pattern = r["pattern"]
        if pattern == "周末/工作日（日均）":
            finding = f"周末日均约为工作日日均的{r['typical']:.1%}"
        elif pattern == "月末7天/其余日期（日均）":
            finding = f"月末7天日均约为当月其余日期的{r['typical']:.1%}"
        elif pattern.startswith(("首销第", "上市第")):
            finding = f"{pattern}的典型日均比为{r['typical']:.1%}"
            status = "上市批次描述，未做跨批次留出验证"
        elif "月/上月" in pattern:
            finding = f"{pattern.split('/')[0]}日均约为上月的{r['typical']:.1%}"
        elif "年度季节指数" in pattern:
            finding = f"该月日均约为同年全年日均的{r['typical']:.1%}"
        else:
            finding = f"该项历史典型比例为{r['typical']:.1%}，相对于同星期控制日"
        if pattern.startswith(("首销第", "上市第")):
            finding += f"；窗口阶段：{r.get('stage', '未提供')}"
        elif r.get("stage") == "首销": finding += "；适用首销批次"
        if r.get("metric") == "小订数量":
            finding = "小订期" + finding
        r.update(finding=finding, evidence_level=status)
        result.append(r)
    result.sort(key=lambda r: (not r["cross_year_candidate"], r.get("stage") != "平销",
        {"小订数量": 0, "留存大定": 1, "交车锁单": 2}.get(r.get("metric"), 3), -r.get("years", 0),
                              -r.get("periods", 0), r["pattern"], r["category"]))
    return result[:12]
