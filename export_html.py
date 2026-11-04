"""Self-contained offline report export; no server, Node, or network dependency."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from datetime import date, datetime
from pathlib import Path

# The three primary order measures shown by the web app.  Keep the source
# field names here: presentation labels are supplied separately in ``metrics``.
# Small orders are a first-class measure, but the reader guarantees that they
# only carry the ``小订阶段`` stage.
FOCUS_METRICS = ("小订数量", "留存大定", "交车锁单")
SERIES_FIELDS = ("model", "metric", "stage", "cycle", "source", "date", "value", "life")


def _load_sibling(name):
    spec = importlib.util.spec_from_file_location("sales_web_" + name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _json_default(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"网页数据不支持的类型：{type(value).__name__}")


def _period_coverage(rows):
    """Match the workbook's period coverage counts for the web audit view."""
    buckets = {}
    for row in rows or []:
        key = (
            row.get("role") or (
                "锁单" if row.get("metric") == "交车锁单" else
                "小订" if row.get("metric") == "小订数量" else "大定"),
            row.get("metric"), row.get("stage"), row.get("kind"),
        )
        item = buckets.setdefault(key, {"role": key[0], "metric": key[1], "stage": key[2], "kind": key[3],
                                        "total": 0, "valid": 0, "current_incomplete": 0,
                                        "previous_incomplete": 0, "negative": 0, "previous_zero": 0})
        item["total"] += 1
        status = str(row.get("status", ""))
        item["valid"] += status == "有效"
        item["current_incomplete"] += status == "本期不完整"
        item["previous_incomplete"] += status == "前期缺失或不完整"
        item["negative"] += "负" in status
        item["previous_zero"] += status == "前期为零"
    return list(buckets.values())


def build_web_data(payload, panel):
    """Build the web payload with three primary measures kept separate."""
    exporter = _load_sibling("export_excel_openpyxl")
    config = json.loads(Path(__file__).with_name("report_config.json").read_text(encoding="utf-8-sig"))
    results = payload["results"]
    grouping = exporter._choose_grouping(results["model_classes"], config)
    focused = [r for r in panel if r["metric"] in FOCUS_METRICS]
    present = {r["metric"] for r in focused}
    dates = [r["date"] for r in focused]
    analysis_dates = [r["date"] for r in panel]
    available_metrics, omitted_metrics = exporter._selected_metrics(results.get("period_comparisons", []), config)
    model_map = {r["model"]: r for r in grouping["entries"]}
    report_series = exporter._report_series(results.get("period_comparisons", []), grouping["categories"], model_map, available_metrics)
    monthly_profiles = exporter.build_monthly_profiles(results, report_series, model_map)
    metrics = [
        dict(key="小订数量", label="小订", source_label="小订数量（仅小订期）", available="小订数量" in present),
        dict(key="留存大定", label="留存大定", source_label="留存大定", available="留存大定" in present),
        dict(key="交车锁单", label="锁单", source_label="交车锁单", available="交车锁单" in present),
    ]
    filtered = {key: list(rows) if isinstance(rows, list) else rows for key, rows in results.items()}
    filtered["model_classes"] = results.get("model_classes", [])
    filtered["period_coverage"] = _period_coverage(results.get("period_comparisons", []))
    rules = _load_sibling("report_rules").build_rule_summary(
        results, model_map, grouping["categories"], available_metrics)
    findings = exporter._headline_findings(rules)
    notes = [
        "目标是辅助销量预测：先查规律适用范围，再比较历史回测与简单基准。",
        "小订、留存大定、锁单是三个独立口径。小订只进入小订期；留存大定使用原表留存大定（兼容读取旧字段净大定）；锁单使用交车锁单。三种口径不相加，也不互相替代。",
        "车型分类只读取同一工作簿的原始属性。首销、平销及不同来源/批次分别计算。",
        "观测合计保留真实零值和负值；缺失日期不补零。含负值的周期不进入倍率模型，不能将此子样本外推到全部留存大定。",
        "历史节假日比较采用节前后同星期对照，只用于解释历史；包含未来对照的节日倍率不用于滚动预测。",
        "P25/P75表示历史倍率分布，不是预测置信区间；周内、月份、节假日系数可能重叠，不自动连乘。",
        "分类汇总可能随车型覆盖变化。单车型、同阶段、同来源/批次的完整周期更适合预测校准。",
    ]
    if payload.get("source_sheets"):
        source_note = "使用原表已合并的逐字段数值及各自来源" if payload.get("source_mode") == "字段级来源" else "同一天同指标的来源候选择一"
        notes.append("逐日输入：" + "、".join(payload["source_sheets"]) + "；" + source_note + "；累计快照、参考曲线及未来日期不进入分析。")
    if payload.get("sample"):
        notes.insert(0, "当前为样例数据，仅验证功能，不能据此确定真实经营规律。")
    return dict(meta=dict(title="鸿蒙智行 · 销量预测规律研究", generated_at=datetime.now().isoformat(timespec="seconds"),
                         source_name=Path(payload.get("source", "鸿蒙智行销量数据汇总.xlsx")).name,
                         date_start=min(dates) if dates else None, date_end=max(dates) if dates else None,
                         analysis_start=min(analysis_dates) if analysis_dates else None,
                         analysis_end=max(analysis_dates) if analysis_dates else None,
                         sha256=payload.get("sha256"), calendar_years=payload.get("calendar_years", []),
                         calendar_events=payload.get("calendar_events", []), calendar_sources=payload.get("calendar_sources", {}), notes=notes,
                         audit=payload.get("audit", {}), source_sheets=payload.get("source_sheets", []),
                         source_mode=payload.get("source_mode"), sample=bool(payload.get("sample")),
                         available_metrics=available_metrics, omitted_metrics=omitted_metrics),
                metrics=metrics, grouping=grouping,
                series=[{key: r.get(key) for key in SERIES_FIELDS} for r in focused],
                results=filtered, rules=rules, findings=findings, monthly_profiles=monthly_profiles,
                source_insights=payload.get("source_insights", {}),
                forecast=payload.get("forecast", {"profiles": [], "backtests": [], "notes": []}))


def pack_records(rows):
    """Column names once, repeated text dictionaries: smaller offline HTML without lossy rounding."""
    if len(rows) < 40:
        return rows
    columns = list(dict.fromkeys(key for row in rows for key in row))
    values = [[row.get(key) for key in columns] for row in rows]
    dictionaries = {}
    for index, key in enumerate(columns):
        cells = [row[index] for row in values if row[index] is not None]
        if not cells or not all(isinstance(value, str) for value in cells):
            continue
        labels = list(dict.fromkeys(cells))
        if len(labels) * 2 >= len(cells):
            continue
        dictionaries[str(index)] = labels
        lookup = {value: j for j, value in enumerate(labels)}
        for row in values:
            if row[index] is not None:
                row[index] = lookup[row[index]]
    return {"$table": 1, "columns": columns, "rows": values, "dictionaries": dictionaries}


def _packed(data):
    clone = dict(data)
    clone["series"] = pack_records(data["series"])
    clone["rules"] = pack_records(data["rules"])
    clone["findings"] = pack_records(data.get("findings", []))
    clone["monthly_profiles"] = pack_records(data.get("monthly_profiles", []))
    clone["source_insights"] = dict(data.get("source_insights", {}))
    for key in ("inventory", "early_launch", "curves", "hourly"):
        clone["source_insights"][key] = pack_records(clone["source_insights"].get(key, []))
    clone["results"] = {key: pack_records(rows) for key, rows in data["results"].items()}
    clone["forecast"] = dict(data["forecast"])
    for key in ("profiles", "backtests"):
        clone["forecast"][key] = pack_records(clone["forecast"].get(key, []))
    return clone


DECODER = r"""
(() => {
  const unpack = table => {
    if (!table || table.$table !== 1) return table;
    return table.rows.map(row => Object.fromEntries(table.columns.map((key, i) => {
      const value = row[i], dict = table.dictionaries[String(i)];
      return [key, dict && value !== null ? dict[value] : value];
    })));
  };
  const data = JSON.parse(document.getElementById('patterns-data').textContent);
  data.series = unpack(data.series); data.rules = unpack(data.rules);
  data.findings = unpack(data.findings); data.monthly_profiles = unpack(data.monthly_profiles);
  data.source_insights = data.source_insights || {};
  for (const key of ['inventory','early_launch','curves','hourly']) data.source_insights[key] = unpack(data.source_insights[key] || []);
  for (const key of Object.keys(data.results)) data.results[key] = unpack(data.results[key]);
  for (const key of ['profiles', 'backtests']) data.forecast[key] = unpack(data.forecast[key]);
  window.PATTERNS_DATA = data;
})();
"""


def render_html(data, template_dir=None):
    folder = Path(template_dir) if template_dir else Path(__file__).with_name("templates")
    template = (folder / "patterns.html").read_text(encoding="utf-8-sig")
    css = (folder / "patterns.css").read_text(encoding="utf-8-sig")
    js = (folder / "patterns.js").read_text(encoding="utf-8-sig")
    serialized = json.dumps(_packed(data), ensure_ascii=False, separators=(",", ":"), default=_json_default, allow_nan=False)
    # User-controlled labels must never close the application/json script element.
    serialized = serialized.replace("&", r"\u0026").replace("<", r"\u003c").replace(">", r"\u003e")
    serialized = serialized.replace(chr(0x2028), r"\u2028").replace(chr(0x2029), r"\u2029")
    replacements = {"__PATTERNS_CSS__": css, "__PATTERNS_JS__": DECODER + js, "__PATTERNS_DATA__": serialized}
    for marker in replacements:
        if template.count(marker) != 1:
            raise ValueError("网页模板占位符不完整或重复：" + marker)
    # Substitute template tokens once, never replace text injected from source data.
    import re
    return re.sub("|".join(re.escape(key) for key in replacements), lambda m: replacements[m[0]], template)


def export_html(html, output_path, log=None):
    log = log or (lambda message: None)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".sales-web-", suffix=".html", dir=output_path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(html)
        if "patterns-data" not in html or "</html>" not in html.lower():
            raise ValueError("网页结构不完整，未替换上次结果")
        os.replace(temp, output_path)
    except PermissionError as exc:
        raise PermissionError("网页保存失败，请检查文件占用或写入权限；上次网页已保留。") from exc
    finally:
        temp.unlink(missing_ok=True)
    log(f"网页保存完成：{output_path.stat().st_size / 1024 / 1024:.2f} MB，可离线直接打开")
    return output_path
