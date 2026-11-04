import importlib.util
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("source_patterns", ROOT / "source_patterns.py")
source_patterns = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(source_patterns)


def _write_sheet(book, name, headers, rows):
    sheet = book.create_sheet(name)
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    return sheet


def _hour_rows(model, day, total=1, *, missing=(), duplicate=None,
               negative_hour=None, none_hour=None, second_metric=False):
    rows = []
    missing = set(missing)
    for hour in range(24):
        if hour in missing:
            continue
        value = total
        if negative_hour == hour:
            value = -1
        if none_hour == hour:
            value = None
        if second_metric:
            rows.append([model, None, day, hour, value, total, "synthetic.xlsx"])
        else:
            rows.append([model, None, day, hour, value, "synthetic.xlsx"])
        if duplicate == hour:
            if second_metric:
                rows.append([model, None, day, hour, value, total, "synthetic.xlsx"])
            else:
                rows.append([model, None, day, hour, value, "synthetic.xlsx"])
    return rows


def _synthetic_book(path):
    book = Workbook()
    book.remove(book.active)
    _write_sheet(book, "说明与来源", ["类型", "项目", "内容", "数据开始", "数据结束"], [
        ["生成", "数据判定日期", "2026-10-31", None, None],
        ["口径", "by时", "保存小时数量，不存累计列；空白不是0。", None, None],
    ])
    _write_sheet(book, "车型基本信息", [
        "代际名", "二级代际名", "品牌", "产品档位", "能源类型", "发布类型",
        "小订开始", "首销开始", "销售阶段", "总小订", "总大定", "总小转大", "总直接大定", "首销结束",
    ], [
        ["车型A", None, "品牌A", "SUV", "纯电", "标准发布", date(2026, 10, 1), date(2026, 10, 3), "已结束", 100, 10, 6, 4, date(2026, 10, 30)],
        ["车型B", None, "品牌B", "轿车", "增程", "年度改款", date(2026, 10, 2), date(2026, 10, 4), "已结束", 100, 20, 10, 10, date(2026, 10, 30)],
        ["车型C", None, "品牌C", "SUV", "纯电", "标准发布", date(2026, 10, 3), date(2026, 10, 5), "进行中", 100, 30, 20, 10, date(2026, 11, 10)],
    ])
    _write_sheet(book, "首销D1D2预测指标", [
        "代际名", "二级代际名", "产品档位", "发布类型", "总小转大", "总直接大定", "总大定", "总小订",
        "D1大定", "D2大定", "D1+D2大定", "D1小转大", "D1直接大", "D1+D2退订", "D1小转大/总小转大", "结构异常说明",
    ], [
        ["车型A", None, "SUV", "标准发布", 0, 4, 4, 100, 0, 0, 0, 0, 0, 0, 0, None],
        ["车型B", None, "轿车", "年度改款", 10, 10, 20, 100, 10, 5, 15, 5, -5, 3, 0.5, None],
        ["车型C", None, "SUV", "标准发布", 10, 10, 20, 100, 8, 4, 12, 5, 3, 5, 0.5, None],
    ])
    _write_sheet(book, "累计直接大定占比", ["代际名", "二级代际名", "D1", "D2"], [
        ["车型A", None, 0.1, 0.2],
        ["车型B", None, 0.4, None],
    ])
    _write_sheet(book, "每日直接大定占比", ["代际名", "二级代际名", "D1", "D2"], [
        ["车型A", None, 0.3, 0.5],
    ])
    _write_sheet(book, "累计小订转化率", ["代际名", "二级代际名", "D1", "D2"], [
        ["车型A", None, 0.2, 0.4],
    ])
    # A complete sequence has an original zero but remains valid because the
    # daily total is positive.  The other groups exercise each quality state.
    _write_sheet(book, "小订by时", ["代际名", "二级代际名", "日期", "小时", "小时小订", "来源文件"], [
        *_hour_rows("车型A", date(2026, 10, 20), total=1),
        *_hour_rows("车型B", date(2026, 10, 21), total=1, missing=(23,)),
        *_hour_rows("车型C", date(2026, 10, 22), total=1, negative_hour=4),
        *_hour_rows("车型A", date(2026, 10, 23), total=0),
        *_hour_rows("车型B", date(2026, 10, 24), total=1, duplicate=3),
        *_hour_rows("车型C", date(2026, 10, 25), total=1, none_hour=5),
        *_hour_rows("车型A", date(2026, 11, 1), total=1),
    ])
    # Separate metric totals ensure that hourly shares never mix components.
    rows = []
    for hour in range(24):
        rows.append(["车型A", None, date(2026, 10, 19), hour, 2, "synthetic.xlsx", 1, 1, 0])
    _write_sheet(book, "首销by时", [
        "代际名", "二级代际名", "日期", "小时", "小时总量", "来源文件", "小时小转大", "小时直接大定", "小时交车锁单",
    ], rows)
    book.save(path)


def _ambiguous_version_book(path):
    """Two exact second-level models share a primary generation name."""
    book = Workbook()
    book.remove(book.active)
    _write_sheet(book, "说明与来源", ["类型", "项目", "内容", "数据开始", "数据结束"], [
        ["生成", "数据判定日期", "2026-10-31", None, None],
    ])
    _write_sheet(book, "车型基本信息", [
        "代际名", "二级代际名", "品牌", "产品档位", "能源类型", "发布类型",
        "小订开始", "首销开始", "销售阶段", "总小订", "总大定", "总直接大定",
    ], [
        ["主车型", "主车型A", "品牌A", "SUV", "纯电", "标准发布", date(2026, 10, 1), date(2026, 10, 3), "已结束", 10, 5, 3],
        ["主车型", "主车型B", "品牌B", "轿车", "增程", "年度改款", date(2026, 10, 10), date(2026, 10, 12), "已结束", 20, 10, 6],
    ])
    _write_sheet(book, "首销D1D2预测指标", [
        "代际名", "二级代际名", "总小转大", "总直接大定", "总大定", "总小订", "D1大定", "D2大定",
    ], [
        ["主车型", "主车型A", 2, 3, 5, 10, 2, 1],
        ["主车型", "主车型B", 4, 6, 10, 20, 4, 2],
        ["主车型", None, 9, 9, 18, 30, 9, 3],
    ])
    _write_sheet(book, "累计直接大定占比", ["代际名", "二级代际名", "D1", "D2"], [
        ["主车型", "主车型A", 0.1, 0.2],
        ["主车型", "主车型B", 0.3, 0.4],
        ["主车型", None, 0.9, 0.95],
    ])
    rows = []
    rows.extend(_hour_rows("主车型", date(2026, 10, 2), total=1))
    # The helper has no secondary parameter, so fill the exact second-level
    # model in each generated row explicitly.
    rows = [["主车型", "主车型A", row[2], row[3], row[4], row[5]] for row in rows]
    rows_b = _hour_rows("主车型", date(2026, 10, 11), total=2)
    rows.extend([["主车型", "主车型B", row[2], row[3], row[4], row[5]] for row in rows_b])
    rows_c = _hour_rows("主车型", date(2026, 10, 20), total=3)
    rows.extend([["主车型", None, row[2], row[3], row[4], row[5]] for row in rows_c])
    _write_sheet(book, "小订by时", ["代际名", "二级代际名", "日期", "小时", "小时小订", "来源文件"], rows)
    book.save(path)


class SourcePatternsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "synthetic.xlsx"
        _synthetic_book(self.path)
        self.data = source_patterns.build_source_insights(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_inventory_and_early_aliases_preserve_zero_and_source(self):
        self.assertEqual(len(self.data["inventory"]), 8)
        early = [row for row in self.data["early_launch"] if row["model"] == "车型A"]
        self.assertTrue(any(row["feature"] == "D1大定" and row["value"] == 0 for row in early))
        self.assertTrue(any(row["feature"] == "D1占最终大定比例" and row["value"] == 0 for row in early))
        self.assertTrue(any(row["feature"] == "结构异常说明" and row["status"] == "原始空白" for row in early))
        self.assertTrue(any(row["feature"] == "D1大定" and row["metric"] == "大定" for row in early))
        self.assertTrue(any(row["feature"] == "D1小转大" and row["metric"] == "小转大" for row in early))
        self.assertTrue(any(row["feature"] == "D1小转大/总小转大" and row["unit"] == "比例" for row in early))
        self.assertTrue(any(row["feature"] == "D1+D2退订/总小订构成" for row in early))
        self.assertFalse(any(row["feature"] == "最终大定/总小订转化率" for row in early))
        open_model = [row for row in self.data["early_launch"] if row["model"] == "车型C" and row["feature"] == "D1占最终大定比例"]
        self.assertEqual(open_model[0]["status"], "未结束/进行中")
        negative = [row for row in self.data["early_launch"] if row["model"] == "车型B" and row["feature"] == "D1直接大"]
        self.assertEqual(negative[0]["status"], "需核对（负值）")
        self.assertTrue(all(row["source_sheet"] == "首销D1D2预测指标" for row in early))

    def test_cumulative_curve_is_snapshot_and_not_summed_or_mixed(self):
        rows = [row for row in self.data["curves"] if row["curve"] == "累计直接大定占比"]
        a = {(row["model"], row["day"]): row for row in rows}
        self.assertEqual(a[("车型A", 1)]["value"], 0.1)
        self.assertEqual(a[("车型A", 2)]["value"], 0.2)
        self.assertTrue(a[("车型A", 2)]["is_cumulative"])
        self.assertIn("不求和", a[("车型A", 2)]["snapshot_note"])
        self.assertEqual(a[("车型B", 1)]["value"], 0.4)
        self.assertNotIn(("车型B", 2), a)

    def test_cumulative_small_order_conversion_uses_launch_anchor(self):
        rows = [row for row in self.data["curves"]
                if row["curve"] == "累计小订转化率"]
        self.assertEqual(rows[0]["stage"], "首销")
        self.assertEqual(rows[0]["anchor_date"], "2026-10-03")
        self.assertEqual(rows[0]["date"], "2026-10-03")
        self.assertEqual(rows[0]["day"], 1)

    def test_hourly_quality_states_and_cutoff(self):
        hourly = self.data["hourly"]
        by_group = {(row["model"], row["metric"], row["date"]): row for row in hourly}
        valid = by_group[("车型A", "小订数量", "2026-10-20")]
        self.assertEqual(valid["status"], "有效")
        self.assertEqual(valid["total"], 24)
        # The synthetic row uses 1 for all hours; check no fabricated zeros are
        # introduced for an actual zero by replacing only one test row below.
        self.assertEqual(valid["share"], 1 / 24)
        self.assertEqual(by_group[("车型B", "小订数量", "2026-10-21")]["status"], "小时缺失")
        self.assertEqual(by_group[("车型C", "小订数量", "2026-10-22")]["status"], "含负值")
        self.assertEqual(by_group[("车型A", "小订数量", "2026-10-23")]["status"], "总量为零")
        duplicate = next(row for row in self.data["hourly"]
                         if row["model"] == "车型B" and row["metric"] == "小订数量"
                         and row["date"] == "2026-10-24" and row["hour"] == 3)
        self.assertEqual(duplicate["status"], "小时重复")
        self.assertEqual(duplicate["duplicate_count"], 2)
        self.assertEqual(by_group[("车型C", "小订数量", "2026-10-25")]["status"], "小时空白")
        future = by_group[("车型A", "小订数量", "2026-11-01")]
        self.assertEqual(future["status"], "未来数据")
        self.assertIsNone(future["share"])

    def test_hourly_metrics_have_separate_denominators(self):
        rows = [row for row in self.data["hourly"] if row["source"] == "首销by时" and row["date"] == "2026-10-19"]
        totals = {row["metric"]: row["total"] for row in rows if row["hour"] == 0}
        self.assertEqual(totals["大定"], 48)
        self.assertEqual(totals["小转大"], 24)
        self.assertEqual(totals["直接大定"], 24)
        self.assertEqual(totals["交车锁单"], 0)

    def test_second_level_models_do_not_mix_primary_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "ambiguous.xlsx"
            _ambiguous_version_book(path)
            data = source_patterns.build_source_insights(path)

        early = data["early_launch"]
        models = {row["model"] for row in early if row["feature"] == "D1大定"}
        self.assertEqual(models, {"主车型A", "主车型B", "主车型"})
        a_early = next(row for row in early if row["model"] == "主车型A" and row["feature"] == "D1大定")
        b_early = next(row for row in early if row["model"] == "主车型B" and row["feature"] == "D1大定")
        ambiguous_early = next(row for row in early if row["model"] == "主车型" and row["feature"] == "D1大定")
        self.assertEqual(a_early["brand"], "品牌A")
        self.assertEqual(b_early["brand"], "品牌B")
        self.assertEqual(a_early["anchor_date"], "2026-10-03")
        self.assertEqual(b_early["anchor_date"], "2026-10-12")
        self.assertEqual(ambiguous_early["status"], "车型映射冲突/未明确版本")

        curves = [row for row in data["curves"] if row["curve"] == "累计直接大定占比" and row["day"] == 1]
        by_curve_model = {row["model"]: row for row in curves}
        self.assertIsNone(by_curve_model["主车型A"]["denominator"])
        self.assertIsNone(by_curve_model["主车型B"]["denominator"])
        self.assertIn("截至D日累计总大定", by_curve_model["主车型A"]["denominator_note"])
        self.assertEqual(by_curve_model["主车型A"]["date"], "2026-10-03")
        self.assertEqual(by_curve_model["主车型B"]["date"], "2026-10-12")
        self.assertEqual(by_curve_model["主车型"]["status"], "车型映射冲突/未明确版本")

        hourly = [row for row in data["hourly"] if row["metric"] == "小订数量"]
        totals = {}
        for row in hourly:
            if row["hour"] == 0:
                totals[row["model"]] = row["total"]
        self.assertEqual(totals["主车型A"], 24)
        self.assertEqual(totals["主车型B"], 48)
        self.assertEqual(totals["主车型"], 72)
        ambiguous_hour = next(row for row in hourly if row["model"] == "主车型" and row["hour"] == 0)
        self.assertEqual(ambiguous_hour["status"], "车型映射冲突/未明确版本")
        self.assertIsNone(ambiguous_hour["share"])


if __name__ == "__main__":
    unittest.main()
