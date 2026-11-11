"""Source quality and denominator contracts for the research workspace."""
import importlib.util
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audit_source_quality", ROOT / "core" / "source_patterns.py")
source_patterns = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_patterns)


def read_book(early=None, curves=None, metadata=None, cutoff="2025-03-01"):
    book = Workbook()
    book.active.title = "说明与来源"
    book.active.append(["项目", "内容"])
    book.active.append(["数据判定日期", cutoff])
    master = {
        "代际名": "车型A", "小订开始": date(2025, 1, 1),
        "首销开始": date(2025, 2, 1), "首销结束": date(2025, 2, 28),
        "首销阶段": "已结束", "总小订": 200, "总大定": 100,
        "总直接大定": 60, "总小转大": 40,
        **(metadata or {}),
    }
    sheet = book.create_sheet("车型基本信息")
    sheet.append(list(master))
    sheet.append(list(master.values()))
    if early is not None:
        row = {"代际名": "车型A", **early}
        sheet = book.create_sheet("首销D1D2预测指标")
        sheet.append(list(row))
        sheet.append(list(row.values()))
    for name, values in (curves or {}).items():
        sheet = book.create_sheet(name)
        sheet.append(["代际名", *[f"D{i+1}" for i in range(len(values))]])
        sheet.append(["车型A", *values])
    with patch.object(source_patterns.openpyxl, "load_workbook", return_value=book):
        return source_patterns.build_source_insights(Path(__file__))


def feature(data, name):
    return next(row for row in data["early_launch"] if row["feature"] == name)


def eligible(row):
    return isinstance(row["value"], (int, float)) and row["value"] >= 0 and row["status"].startswith(("有效", "通过"))


class EarlyQualityTests(unittest.TestCase):
    def test_conflicting_structure_keeps_facts_but_excludes_research_ratios(self):
        data = read_book(early={"D1大定": 10, "D1小转大": 8, "D1直接大": 8,
            "总大定": 100, "D1口径状态": "数据不足或异常",
            "D1小转大/D1大定": .8, "结构异常说明": "D1小转大+直接大定与总大定不一致"})
        self.assertEqual(feature(data, "D1大定")["value"], 10)
        for name in ("D1小转大构成", "D1直接大定构成", "D1占最终大定比例", "D1小转大/D1大定"):
            with self.subTest(name=name):
                self.assertFalse(eligible(feature(data, name)))
                self.assertIn("数据不足或异常", feature(data, name)["status"])

    def test_partial_fields_do_not_erase_independent_known_ratios_or_zero(self):
        data = read_book(early={"D1大定": 0, "D2大定": 20, "D1+D2大定": 20,
            "总大定": 100, "D1口径状态": "部分字段有效", "D2口径状态": "部分字段有效",
            "D1+D2口径状态": "部分字段有效"})
        self.assertTrue(eligible(feature(data, "D1占最终大定比例")))
        self.assertEqual(feature(data, "D1占最终大定比例")["value"], 0)
        self.assertTrue(eligible(feature(data, "D1+D2占最终大定比例")))
        self.assertEqual(feature(data, "D2/D1大定比")["status"], "分母为零")

    def test_pair_ratios_check_both_days_and_combined_status(self):
        for invalid in ("D1口径状态", "D2口径状态", "D1+D2口径状态"):
            early = {"D1大定": 10, "D2大定": 20, "D1+D2大定": 30, "总大定": 100,
                "D1口径状态": "通过", "D2口径状态": "通过", "D1+D2口径状态": "通过",
                "D1大定/D1+D2大定": 1/3, invalid: "当日未结束"}
            data = read_book(early=early)
            self.assertFalse(eligible(feature(data, "D1+D2占最终大定比例")), invalid)
            self.assertFalse(eligible(feature(data, "D1大定/D1+D2大定")), invalid)
            if invalid != "D1+D2口径状态":
                self.assertFalse(eligible(feature(data, "D2/D1大定比")), invalid)

    def test_legacy_missing_status_preserves_known_independent_ratios(self):
        data = read_book(early={"D1大定": 10, "D2大定": 20, "总大定": 100})
        self.assertTrue(eligible(feature(data, "D1占最终大定比例")))
        self.assertTrue(eligible(feature(data, "D2/D1大定比")))
        self.assertEqual(feature(data, "D2/D1大定比")["value"], 2)

    def test_unknown_explicit_status_is_evidence_only(self):
        for status in ("待核对", "", "未来日期", "时间未维护"):
            data = read_book(early={"D1大定": 10, "总大定": 100, "D1口径状态": status})
            self.assertEqual(feature(data, "D1大定")["value"], 10)
            self.assertFalse(eligible(feature(data, "D1占最终大定比例")), status)

    def test_legacy_day_two_not_finished_cannot_enter_ratio_samples(self):
        data = read_book(early={"D1大定": 10, "D2大定": 20, "D2大定/D1大定": 2,
            "总大定": 100}, cutoff="2025-02-02")
        self.assertTrue(eligible(feature(data, "D1占最终大定比例")))
        self.assertFalse(eligible(feature(data, "D2/D1大定比")))
        self.assertFalse(eligible(feature(data, "D2大定/D1大定")))


class CurveDenominatorTests(unittest.TestCase):
    def test_daily_and_cumulative_direct_shares_never_use_whole_phase_total(self):
        data = read_book(curves={"每日直接大定占比": [.4, .7], "累计直接大定占比": [.4, .6]})
        for row in data["curves"]:
            self.assertIsNone(row["denominator"])
            self.assertNotIn("车型基本信息.总直接大定", row["denominator_note"])
            self.assertIn("累计总大定" if row["is_cumulative"] else "当日总大定", row["denominator_note"])
        self.assertEqual([row["value"] for row in data["curves"]], [.4, .7, .4, .6])

    def test_completion_curves_keep_their_own_explicit_terminal_totals(self):
        data = read_book(curves={"小订累计完成度": [0, .2], "直接大定累计完成度": [.1, .4],
                                "累计直接大定进度": [.1, .4]})
        by_name = {r["curve"]: r for r in data["curves"]}
        self.assertEqual(by_name["小订累计完成度"]["denominator"], 200)
        for name in ("直接大定累计完成度", "累计直接大定进度"):
            self.assertEqual(by_name[name]["denominator"], 60)
            self.assertEqual(by_name[name]["unit"], "比例")
        self.assertEqual([r["value"] for r in data["curves"] if r["curve"] == "小订累计完成度"], [0, .2])

    def test_absent_denominator_remains_unknown_without_back_calculation(self):
        data = read_book(curves={"小订累计完成度": [.5]}, metadata={"总小订": None})
        row = data["curves"][0]
        self.assertIsNone(row["denominator"])
        self.assertEqual(row["value"], .5)


if __name__ == "__main__":
    unittest.main()
