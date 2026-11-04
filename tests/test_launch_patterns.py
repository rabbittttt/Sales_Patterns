import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launch = load("launch_patterns")
rules = load("report_rules")


def panel_rows(model="车型A", metric="留存大定", start=date(2025, 8, 1),
               values=None, source="首销日表"):
    values = list(values or [])
    return [
        {
            "model": model, "metric": metric, "stage": "首销",
            "cycle": start.isoformat(), "source": source,
            "brand": "品牌", "segment": "SUV", "energy": "增程",
            "date": start + timedelta(days=index), "life": index + 1,
            "value": value,
        }
        for index, value in enumerate(values)
    ]


def post_launch_rows(model="车型A", metric="留存大定", launch_start=date(2025, 8, 1),
                     launch_end=date(2025, 8, 7), days=21, value=1,
                     source="首销日表", missing_days=()):
    rows = []
    for index in range(days):
        if index in set(missing_days):
            continue
        day = launch_start + timedelta(days=index)
        rows.append({
            "model": model, "metric": metric,
            "stage": "首销" if day <= launch_end else "平销",
            "cycle": launch_start.isoformat(), "launch_start": launch_start,
            "launch_end": launch_end, "source": source,
            "sheet": "小订首销平销by天", "brand": "品牌", "segment": "SUV",
            "energy": "增程", "date": day, "life": index + 1,
            "value": value,
        })
    return rows


class LaunchPatternTests(unittest.TestCase):
    def test_second_and_third_launch_weeks_are_separate_for_net_and_lock(self):
        rows = []
        for metric, values in (
            ("留存大定", [1] * 7 + [2] * 7 + [3] * 7),
            ("交车锁单", [2] * 7 + [3] * 7 + [6] * 7),
        ):
            rows.extend(panel_rows(metric=metric, values=values))

        output = launch.build_launch_pacing(rows)
        self.assertEqual(len(output), 4)
        net = [row for row in output if row["metric"] == "留存大定"]
        lock = [row for row in output if row["metric"] == "交车锁单"]
        self.assertEqual([row["pattern"] for row in net],
                         ["上市第2周/第1周", "上市第3周/第2周"])
        self.assertEqual([row["ratio"] for row in net], [2.0, 1.5])
        self.assertEqual([row["ratio"] for row in lock], [1.5, 2.0])
        second = next(row for row in net if row["pattern"] == "上市第2周/第1周")
        self.assertEqual((second["current_observed"], second["previous_observed"]), (7, 7))
        self.assertEqual((second["start"], second["end"]), (date(2025, 8, 8), date(2025, 8, 14)))

    def test_missing_negative_and_zero_denominator_are_explicit(self):
        rows = panel_rows(values=[5] * 7 + [0, 0, 0, 0, 0, 0])
        output = launch.build_launch_pacing(rows)
        second = next(row for row in output if row["pattern"] == "上市第2周/第1周")
        self.assertIsNone(second["ratio"])
        self.assertEqual(second["status"], "本期缺失或不完整")
        self.assertEqual((second["current_observed"], second["previous_observed"]), (6, 7))

        rows = panel_rows(model="车型B", values=[0] * 14)
        output = launch.build_launch_pacing(rows)
        second = next(row for row in output if row["pattern"] == "上市第2周/第1周")
        self.assertIsNone(second["ratio"])
        self.assertEqual(second["status"], "前期为零")

        rows = panel_rows(model="车型C", values=[4] * 7 + [-1] + [4] * 6)
        output = launch.build_launch_pacing(rows)
        second = next(row for row in output if row["pattern"] == "上市第2周/第1周")
        self.assertIsNone(second["ratio"])
        self.assertEqual(second["status"], "本期含负值")

        rows = panel_rows(model="车型D", values=[4] * 7 + [0] * 7)
        second = next(row for row in launch.build_launch_pacing(rows)
                      if row["pattern"] == "上市第2周/第1周")
        self.assertEqual(second["ratio"], 0.0)
        self.assertEqual(second["status"], "有效")

    def test_invalid_lifecycle_source_switch_and_duplicate_never_overwrite(self):
        rows = panel_rows(values=[1] * 14)
        rows[7]["life"] = 99
        output = launch.build_launch_pacing(rows)
        second = next(row for row in output if row["pattern"] == "上市第2周/第1周")
        self.assertIsNone(second["ratio"])
        self.assertEqual(second["status"], "本期缺失或不完整")
        self.assertEqual(second["current_observed"], 6)

        switched = panel_rows(values=[1] * 14)
        switched[7]["source"] = "另一来源"
        output = launch.build_launch_pacing(switched)
        self.assertEqual(len(output), 1)
        self.assertTrue(all(row["ratio"] is None for row in output))
        self.assertTrue(all(row["status"] == "来源切换不可比" for row in output))
        self.assertEqual(sorted((row["current_observed"], row["previous_observed"])
                                for row in output), [(7, 7)])
        self.assertEqual(output[0]["previous_source"], "首销日表")
        self.assertEqual(set(output[0]["current_sources"]), {"首销日表", "另一来源"})

        with self.assertRaisesRegex(ValueError, "同一日重复"):
            launch.build_launch_pacing(rows + [dict(rows[0])])

    def test_only_touched_second_or_third_week_is_emitted(self):
        rows = panel_rows(values=[1] * 7)
        self.assertEqual(launch.build_launch_pacing(rows), [])
        rows = panel_rows(values=[1] * 7 + [2])
        output = launch.build_launch_pacing(rows)
        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["pattern"], "上市第2周/第1周")
        self.assertEqual(output[0]["current_observed"], 1)
        self.assertIsNone(output[0]["ratio"])

    def test_launch_pacing_traces_resolved_daily_sheet_and_rejects_other_sheets(self):
        rows = panel_rows(values=[1] * 7 + [2] * 7)
        for row in rows:
            row["sheet"] = "首销by时"
        rows.extend(dict(row, sheet="小订首销平销by天") for row in panel_rows(
            model="车型B", values=[1] * 7 + [3] * 7))
        output = launch.build_launch_pacing(rows)
        self.assertEqual({row["model"] for row in output}, {"车型B"})
        self.assertTrue(all(row["sheet"] == "小订首销平销by天" for row in output))

    def test_launch_analysis_covers_cross_stage_and_more_than_three_weeks(self):
        rows = post_launch_rows(launch_start=date(2025, 8, 25),
                                launch_end=date(2025, 9, 5), days=42)
        result = launch.build_launch_analysis(rows)
        periods = [row for row in result["periods"] if row["grain"] == "周"]
        self.assertEqual([row["period_no"] for row in periods], [1, 2, 3, 4, 5, 6])
        self.assertEqual([row["stage"] for row in periods],
                         ["首销", "跨阶段", "平销", "平销", "平销", "平销"])
        comparisons = [row for row in result["comparisons"] if row["grain"] == "周"]
        self.assertEqual(len(comparisons), 5)
        self.assertEqual(comparisons[0]["pattern"], "上市第2周/第1周")
        self.assertEqual((comparisons[0]["previous_stage"], comparisons[0]["current_stage"],
                          comparisons[0]["stage"]), ("首销", "跨阶段", "跨阶段"))
        self.assertEqual(comparisons[1]["stage"], "跨阶段")
        self.assertEqual(comparisons[2]["stage"], "平销")

    def test_launch_month_uses_anniversary_anchor_and_daily_ratio(self):
        rows = post_launch_rows(launch_start=date(2025, 1, 31),
                                launch_end=date(2025, 1, 31), days=59)
        for row in rows:
            if row["date"] >= date(2025, 2, 28):
                row["value"] = 2
        result = launch.build_launch_analysis(rows)
        periods = [row for row in result["periods"] if row["grain"] == "月"]
        self.assertEqual([(row["period_no"], row["start"], row["end"], row["expected_days"])
                          for row in periods],
                         [(1, date(2025, 1, 31), date(2025, 2, 27), 28),
                          (2, date(2025, 2, 28), date(2025, 3, 30), 31)])
        self.assertEqual([row["daily_avg"] for row in periods], [1.0, 2.0])
        comparison = next(row for row in result["comparisons"] if row["grain"] == "月")
        self.assertEqual(comparison["pattern"], "上市第2月/第1月")
        self.assertAlmostEqual(comparison["daily_ratio"], 2.0)
        self.assertAlmostEqual(comparison["ratio"], 62 / 28)
        self.assertEqual(comparison["stage"], "跨阶段")

    def test_launch_analysis_does_not_attach_flat_sale_without_boundaries(self):
        flat = {
            "model": "无锚点", "metric": "留存大定", "stage": "平销",
            "cycle": "平销", "date": date(2025, 8, 10), "life": None,
            "value": 10, "source": "来源", "sheet": "小订首销平销by天",
        }
        result = launch.build_launch_analysis([flat])
        self.assertEqual(result, {"periods": [], "comparisons": []})
        first = dict(flat, model="有首销锚点", stage="首销", cycle="2025-08-01",
                     launch_start=date(2025, 8, 1), launch_end=None, life=10,
                     date=date(2025, 8, 10))
        result = launch.build_launch_analysis([first])
        self.assertEqual(len(result["periods"]), 2)
        self.assertTrue(all(row["stage"] == "首销" for row in result["periods"]))

    def test_rule_summary_uses_model_equal_launch_pacing_and_marks_no_holdout(self):
        rows = []
        rows.extend(panel_rows(model="车型A", values=[1] * 7 + [2] * 7))
        rows.extend(panel_rows(model="车型B", values=[1] * 7 + [4] * 7))
        launch_rows = launch.build_launch_pacing(rows)
        results = {"launch_pacing": launch_rows}
        model_map = {"车型A": {"category": "A"}, "车型B": {"category": "B"}}
        output = rules.build_rule_summary(results, model_map, ["A", "B"])
        all_models = next(row for row in output
                          if row["category"] == "全部车型"
                          and row["pattern"] == "上市第2周/第1周")
        self.assertEqual(all_models["typical"], 3.0)
        self.assertEqual(all_models["models"], 2)
        self.assertEqual(all_models["samples"], 2)
        self.assertEqual(all_models["detail_sheet"], "生命周期明细")
        self.assertEqual(all_models["validation_note"],
                         "上市批次描述；上市月按首销日逐月划分，使用日均比；未做跨批次留出验证")
        self.assertIn("未做跨批次留出验证", all_models["conclusion"])


if __name__ == "__main__":
    unittest.main()
