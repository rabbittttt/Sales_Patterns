"""Hourly research must use the same explicit phase dates as daily research."""
import importlib.util
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audit_hourly_stage", ROOT / "core" / "source_patterns.py")
source_patterns = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_patterns)


def read_hours(days, *, sheet="首销by时", metadata=None, missing_hour=None, negative=False, source_status=None):
    book = Workbook()
    book.active.title = "说明与来源"
    book.active.append(["项目", "内容"])
    book.active.append(["数据判定日期", "2025-02-01"])
    master = {"代际名": "车型A", "首销开始": date(2025, 1, 5), "首销结束": date(2025, 1, 7),
              "小订开始": date(2025, 1, 1), "小订结束": date(2025, 1, 5),
              "首销阶段": "已结束", **(metadata or {})}
    model_sheet = book.create_sheet("车型基本信息")
    model_sheet.append(list(master))
    model_sheet.append(list(master.values()))
    hour_sheet = book.create_sheet(sheet)
    metric = "小时小订" if sheet == "小订by时" else "小时交车锁单"
    hour_sheet.append(["代际名", "日期", "小时", metric, "来源文件"]
                      + (["分时口径状态"] if source_status is not None else []))
    for day in days:
        for hour in range(24):
            if hour != missing_hour:
                hour_sheet.append(["车型A", date.fromisoformat(day), hour,
                                   -1 if negative and hour == 1 else hour, "业务源.xlsx"]
                                  + ([source_status] if source_status is not None else []))
    with patch.object(source_patterns.openpyxl, "load_workbook", return_value=book):
        return source_patterns.build_source_insights(Path(__file__))["hourly"]


def first_by_day(rows):
    return {r["date"]: r for r in rows if r["hour"] == 0}


class HourlyStageTests(unittest.TestCase):
    def test_launch_boundaries_and_post_launch_follow_explicit_dates(self):
        rows = read_hours(["2025-01-04", "2025-01-05", "2025-01-07", "2025-01-08"])
        by_day = first_by_day(rows)
        self.assertEqual([r["stage"] for r in by_day.values()], ["首销前", "首销", "首销", "平销"])
        self.assertIsNone(by_day["2025-01-04"]["share"])
        for day in ("2025-01-05", "2025-01-07", "2025-01-08"):
            self.assertEqual(by_day[day]["share"], 0)
            self.assertEqual(by_day[day]["group_status"], "有效")
            self.assertEqual(by_day[day]["total"], 276)
            self.assertAlmostEqual(sum(r["share"] for r in rows if r["date"] == day), 1)
        self.assertTrue(all(r["source_sheet"] == "首销by时" for r in rows))
        self.assertEqual([r["value"] for r in rows], list(range(24))*4)

    def test_missing_launch_boundaries_retain_values_as_unknown_evidence(self):
        for missing in ("首销开始", "首销结束"):
            with self.subTest(missing=missing):
                rows = read_hours(["2025-01-06"], metadata={missing: None})
                self.assertEqual({r["stage"] for r in rows}, {"阶段未知"})
                self.assertEqual([r["value"] for r in rows], list(range(24)))
                self.assertTrue(all(r["share"] is None for r in rows))
                self.assertTrue(all(r["group_status"] != "有效" for r in rows))

    def test_reversed_launch_boundaries_are_not_valid_training_samples(self):
        rows = read_hours(["2025-01-06"], metadata={"首销开始": date(2025, 1, 8)})
        self.assertEqual({r["stage"] for r in rows}, {"阶段未知"})
        self.assertTrue(all(r["share"] is None for r in rows))

    def test_small_order_window_is_separate_and_never_reclassified_to_orders(self):
        rows = read_hours(["2024-12-31", "2025-01-01", "2025-01-05", "2025-01-06"], sheet="小订by时")
        by_day = first_by_day(rows)
        for day in ("2025-01-01", "2025-01-05"):
            self.assertEqual(by_day[day]["stage"], "小订")
            self.assertEqual(by_day[day]["group_status"], "有效")
        for day in ("2024-12-31", "2025-01-06"):
            self.assertIsNone(by_day[day]["share"])
            self.assertNotIn(by_day[day]["stage"], ("首销", "平销"))
        self.assertEqual({r["metric"] for r in rows}, {"小订数量"})

    def test_small_order_missing_bounds_preserves_existing_small_order_rule(self):
        # Daily small orders explicitly permit missing small-order boundaries;
        # only a known outside-window date is rejected for this metric.
        rows = read_hours(["2025-01-03"], sheet="小订by时", metadata={"小订结束": None})
        self.assertEqual({r["stage"] for r in rows}, {"小订"})
        self.assertTrue(all(r["group_status"] == "有效" for r in rows))

    def test_post_launch_still_requires_complete_nonnegative_hours(self):
        for kwargs in ({"missing_hour": 23}, {"negative": True}):
            with self.subTest(kwargs=kwargs):
                rows = read_hours(["2025-01-08"], **kwargs)
                self.assertEqual({r["stage"] for r in rows}, {"平销"})
                self.assertTrue(all(r["share"] is None for r in rows))

    def test_cutoff_day_never_becomes_completed_flat_sales_sample(self):
        rows = read_hours(["2025-02-01"])
        self.assertEqual({r["stage"] for r in rows}, {"平销"})
        self.assertTrue(all(r["group_status"] == "未来数据" for r in rows))
        self.assertTrue(all(r["share"] is None for r in rows))

    def test_upstream_invalid_hour_bucket_cannot_be_requalified_as_complete(self):
        for status in ("分时数据异常：小时重复", "分时数据异常：小时无效", "分时数据异常：数量无效", "待核对", ""):
            with self.subTest(status=status):
                rows = read_hours(["2025-01-03"], sheet="小订by时", source_status=status)
                self.assertEqual(len(rows), 24)  # Quality metadata never becomes a measurement.
                self.assertEqual([r["value"] for r in rows], list(range(24)))
                self.assertTrue(all(r["share"] is None for r in rows))
                self.assertTrue(all("来源分时口径异常" in r["group_status"] for r in rows))

    def test_explicit_valid_hour_bucket_keeps_original_fraction_and_zero(self):
        rows = read_hours(["2025-01-03"], sheet="小订by时", source_status="有效")
        legacy = read_hours(["2025-01-03"], sheet="小订by时")
        self.assertEqual(rows, legacy)


if __name__ == "__main__":
    unittest.main()
