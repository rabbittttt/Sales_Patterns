import calendar
import unittest
from datetime import date

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sales_rules_test", Path(__file__).resolve().parents[1] / "report_rules.py"
)
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)
build_rule_summary = rules.build_rule_summary


def annual_comparison(model, year, metric="大定", stage="平销", cycle="平销", source="ERP",
                      observed=None, negative=0):
    days = 366 if calendar.isleap(year) else 365
    return {
        "model": model, "metric": metric, "stage": stage, "cycle": cycle, "source": source,
        "kind": "年", "start": date(year, 1, 1), "end": date(year, 12, 31),
        "current": 0, "current_days": days, "current_observed": days if observed is None else observed,
        "current_negative_days": negative, "previous_negative_days": 0, "status": "有效",
    }


def fixture(values_by_category, years=(2021, 2022, 2023), end=None):
    model_map, weekly, comparisons = {}, [], []
    for category, model_values in values_by_category.items():
        for model, values in model_values.items():
            model_map[model] = {"category": category}
            for index, year in enumerate(years):
                comparisons.append(annual_comparison(model, year))
                weekly.append({
                    "model": model, "metric": "大定", "stage": "平销", "cycle": "平销",
                    "source": "ERP", "week": date(year, 1, 4), "ratio": values[index],
                })
    return {
        "coverage": [{"metric": "大定", "stage": "平销", "end": end or date(years[-1], 12, 31)}],
        "weekly": weekly, "monthly": [], "annual": [], "holidays": [],
        "period_comparisons": comparisons,
    }, model_map


def find_rule(rows, category, pattern="周末/工作日（日均）"):
    return next(r for r in rows if r["category"] == category and r["pattern"] == pattern
                and r["metric"] == "大定" and r["stage"] == "平销")


class RuleSummaryTests(unittest.TestCase):
    def test_latest_year_same_and_opposite_direction(self):
        results, models = fixture({
            "A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]},
            "B": {"b1": [.8, .9, 1.2], "b2": [.9, .95, 1.1]},
        })
        rows = build_rule_summary(results, models, ["A", "B"])
        self.assertEqual(find_rule(rows, "A")["validation_year"], 2023)
        self.assertEqual(find_rule(rows, "A")["validation_status"], "同向")
        self.assertEqual(find_rule(rows, "A")["validation_models"], 2)
        self.assertEqual(find_rule(rows, "A")["validation_train_years"], 2)
        self.assertEqual(find_rule(rows, "B")["validation_status"], "不同向")
        self.assertLess(find_rule(rows, "A")["train_ratio"], 1)
        self.assertGreater(find_rule(rows, "B")["validation_ratio"], 1)

    def test_partial_latest_year_is_not_used_as_holdout_or_training(self):
        results, models = fixture(
            {"A": {"a1": [.8, .9, .8], "a2": [.9, .95, .85]}},
            years=(2021, 2022, 2023),
            end=date(2024, 6, 30),
        )
        for model in models:
            results["weekly"].append({
                "model": model, "metric": "大定", "stage": "平销", "cycle": "平销",
                "source": "ERP", "week": date(2024, 1, 8), "ratio": 9.0,
            })
        rows = build_rule_summary(results, models, ["A"])
        rule = find_rule(rows, "A")
        self.assertEqual(rule["validation_year"], 2023)
        self.assertEqual(rule["years"], 4)
        self.assertEqual(rule["samples"], 8)
        self.assertLess(rule["typical"], 1)
        self.assertLess(rule["validation_ratio"], 1)
        self.assertNotEqual(rule["validation_ratio"], 9.0)

    def test_different_models_cannot_form_temporal_validation(self):
        results = {
            "coverage": [{"metric": "大定", "stage": "平销", "end": date(2023, 12, 31)}],
            "weekly": [
                {"model": "old", "metric": "大定", "stage": "平销", "cycle": "平销",
                 "source": "ERP", "week": date(y, 1, 4), "ratio": .8}
                for y in (2021, 2022)
            ] + [
                {"model": "new", "metric": "大定", "stage": "平销", "cycle": "平销",
                 "source": "ERP", "week": date(2023, 1, 2), "ratio": 1.2}
            ],
            "monthly": [], "annual": [], "holidays": [],
            "period_comparisons": [annual_comparison("old", y) for y in (2021, 2022)]
                                  + [annual_comparison("new", 2023)],
        }
        rows = build_rule_summary(results, {"old": {"category": "A"}, "new": {"category": "A"}}, ["A"])
        rule = find_rule(rows, "A")
        self.assertEqual(rule["validation_status"], "样本不足（缺少同车型、批次、来源的训练期）")
        self.assertIsNone(rule["train_ratio"])
        self.assertIsNone(rule["validation_ratio"])

    def test_zero_is_retained_none_is_ignored_and_negative_comparison_is_excluded(self):
        results, models = fixture(
            {"A": {"a1": [0, None, 0], "a2": [0, None, 0]}},
        )
        rows = build_rule_summary(results, models, ["A"])
        rule = find_rule(rows, "A")
        self.assertEqual(rule["typical"], 0)
        self.assertEqual(rule["samples"], 4)
        self.assertEqual(rule["years"], 2)

        negative = {
            "model": "a1", "metric": "大定", "stage": "平销", "cycle": "平销", "source": "ERP",
            "kind": "月", "start": date(2022, 1, 1), "status": "有效",
            "daily_ratio": 2.0, "current_negative_days": 1, "previous_negative_days": 0,
        }
        results["period_comparisons"].append(negative)
        rows = build_rule_summary(results, models, ["A"])
        january = find_rule(rows, "A", "1月/上月（日均）")
        self.assertEqual(january["samples"], 0)

    def test_incomplete_or_negative_year_is_not_annual_evidence(self):
        results, models = fixture({"A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]}})
        # A handful of observed days cannot certify the year, and negative rows
        # invalidate that exact model/year even when all other fields look complete.
        results["period_comparisons"] = [
            row for row in results["period_comparisons"]
            if not (row.get("kind") == "年" and row.get("start") == date(2023, 1, 1))
        ]
        results["period_comparisons"].append(annual_comparison("a1", 2023, observed=10))
        results["period_comparisons"].append(annual_comparison("a2", 2023, negative=1))
        rows = build_rule_summary(results, models, ["A"])
        rule = find_rule(rows, "A")
        self.assertEqual(rule["validation_status"], "未覆盖完整年度")
        self.assertEqual(rule["years"], 3)
        self.assertIsNotNone(rule["typical"])

    def test_month_and_holiday_zero_ratios_are_kept_and_none_filtered(self):
        results, models = fixture({"A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]}})
        for model in models:
            for year in (2021, 2022, 2023):
                results["period_comparisons"].append({
                    "model": model, "metric": "大定", "stage": "平销", "cycle": "平销",
                    "source": "ERP", "kind": "月", "start": date(year, 1, 1),
                    "status": "有效", "daily_ratio": 0.0 if year < 2023 else None,
                    "current_negative_days": 0, "previous_negative_days": 0,
                })
            results["holidays"].append({
                "model": model, "metric": "大定", "stage": "平销", "cycle": "平销",
                "source": "ERP", "year": 2021, "holiday": "春节",
                "before": 0.0, "during": None, "after": 1.1,
            })
            results["holidays"].append({
                "model": model, "metric": "大定", "stage": "平销", "cycle": "平销",
                "source": "ERP", "year": 2023, "holiday": "春节",
                "before": 0.0, "during": 0.0, "after": 1.2,
            })
        rows = build_rule_summary(results, models, ["A"])
        january = find_rule(rows, "A", "1月/上月（日均）")
        before = find_rule(rows, "A", "春节节前")
        during = find_rule(rows, "A", "春节节中")
        self.assertEqual(january["typical"], 0.0)
        self.assertEqual(january["samples"], 4)
        self.assertEqual(before["typical"], 0.0)
        self.assertEqual(during["typical"], 0.0)
        self.assertEqual(before["detail_sheet"], "节假日明细")

    def test_partial_only_descriptive_data_remains_when_no_full_validation_year(self):
        results, models = fixture({"A": {"a1": [.8, .9], "a2": [.9, .95]}},
                                  years=(2021, 2022), end=date(2022, 6, 30))
        results["period_comparisons"] = [
            row for row in results["period_comparisons"]
            if row["start"] != date(2021, 1, 1)
        ]
        rows = build_rule_summary(results, models, ["A"])
        rule = find_rule(rows, "A")
        self.assertIsNotNone(rule["typical"])
        self.assertEqual(rule["validation_year"], 2021)
        self.assertEqual(rule["validation_status"], "未覆盖完整年度")
        self.assertEqual(rule["years"], 2)

    def test_one_model_and_one_train_year_can_report_direction_with_note(self):
        results, models = fixture({"A": {"only-model": [.8, .7]},}, years=(2022, 2023))
        rule = find_rule(build_rule_summary(results, models, ["A"]), "A")
        self.assertEqual(rule["validation_status"], "同向")
        self.assertIn("1个车型、1个训练完整年度", rule["validation_note"])
        self.assertIn("仅作方向对照", rule["conclusion"])

    def test_previous_year_negative_count_does_not_invalidate_current_complete_year(self):
        results, models = fixture({"A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]}})
        for row in results["period_comparisons"]:
            if row["kind"] == "年" and row["start"] == date(2023, 1, 1):
                row["previous_negative_days"] = 5
        rule = find_rule(build_rule_summary(results, models, ["A"]), "A")
        self.assertEqual(rule["validation_year"], 2023)
        self.assertIn(rule["validation_status"], ("同向", "不同向"))

    def test_coverage_does_not_create_cross_category_metric_rows(self):
        results, models = fixture({"A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]}})
        models["b1"] = {"category": "B"}
        results["coverage"].append({"metric": "小订数量", "stage": "首销", "end": date(2023, 12, 31)})
        rows = build_rule_summary(results, models, ["A", "B"])
        self.assertTrue(any(r["category"] == "全部车型" and r["metric"] == "小订数量"
                            and r["stage"] == "首销" for r in rows))
        self.assertFalse(any(r["category"] == "B" and r["metric"] == "小订数量"
                             and r["stage"] == "首销" for r in rows))

    def test_selected_metrics_filters_results(self):
        results, models = fixture({"A": {"a1": [.8, .9, .7], "a2": [.9, .95, .8]}})
        rows = build_rule_summary(results, models, ["A"], selected_metrics=["小订数量"])
        self.assertEqual(rows, [])

    def test_post_launch_rules_use_daily_ratio_and_keep_phase_and_metric_separate(self):
        base = dict(model="a", metric="留存大定", stage="跨阶段", cycle="2025-01-01",
                    source="逐日", grain="月", pattern="上市第2月/第1月", status="有效",
                    previous=310, current=280, ratio=280/310, daily_ratio=1)
        results = {"launch_pacing": [base, dict(base, stage="平销", daily_ratio=.8),
                                      dict(base, metric="交车锁单", daily_ratio=1.2),
                                      dict(base, model="b", status="来源切换不可比", daily_ratio=9)]}
        rows = build_rule_summary(results, {"a":{"category":"A"},"b":{"category":"A"}}, ["A"])
        overall = {(r["metric"],r["stage"]):r for r in rows if r["category"]=="全部车型"}
        self.assertEqual(overall["留存大定","跨阶段"]["typical"],1)
        self.assertEqual(overall["留存大定","平销"]["typical"],.8)
        self.assertEqual(overall["交车锁单","跨阶段"]["typical"],1.2)
        self.assertEqual(overall["留存大定","跨阶段"]["models"],1)
        self.assertEqual(overall["留存大定","跨阶段"]["unit"],"日均比例")
        self.assertIn("未做跨批次",overall["留存大定","跨阶段"]["conclusion"])

    def test_post_launch_missing_daily_ratio_is_not_replaced_by_total_ratio(self):
        row = dict(model="a",metric="留存大定",stage="平销",cycle="2025-01-01",source="逐日",
                   pattern="上市第3月/第2月",status="有效",ratio=2,daily_ratio=None)
        rows = build_rule_summary({"launch_pacing":[row]}, {"a":{"category":"A"}}, ["A"])
        self.assertTrue(rows)
        self.assertTrue(all(r["typical"] is None for r in rows))


if __name__ == "__main__":
    unittest.main()
