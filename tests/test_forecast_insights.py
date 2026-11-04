"""Regression coverage for the isolated rolling forecast insights."""
from __future__ import annotations

import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "forecast_insights.py"
SPEC = importlib.util.spec_from_file_location("forecast_insights", MODULE_PATH)
forecast = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(forecast)


def make_rows(start: date, end: date, metric: str = "留存大定", model: str = "M1",
              stage: str = "上市期", cycle: str = "常规", source: str = "src",
              missing: set[date] | None = None, value_fn=None,
              small_end: date | None = None) -> list[dict]:
    missing = missing or set()
    rows = []
    current = start
    while current <= end:
        if current not in missing:
            value = value_fn(current) if value_fn else 100 + current.weekday() * 4 + current.month
            row = {
                "model": model, "metric": metric, "stage": stage, "cycle": cycle,
                "source": source, "date": current, "value": value,
                "life": "上市", "brand": "B", "segment": "S", "energy": "E",
            }
            if small_end is not None:
                row["small_end"] = small_end
            rows.append(row)
        current += timedelta(days=1)
    return rows


class ForecastInsightsTests(unittest.TestCase):
    def setUp(self):
        self.start = date(2022, 1, 1)
        self.end = date(2024, 12, 31)

    def test_three_metrics_and_all_series_dimensions_are_isolated(self):
        rows = make_rows(self.start, self.end, metric="留存大定")
        rows += make_rows(self.start, self.end, metric="交车锁单", value_fn=lambda d: 2 * (100 + d.weekday() * 4 + d.month))
        rows += make_rows(self.start, self.end, metric="小订数量", stage="小订阶段",
                          value_fn=lambda d: 0.5 * (100 + d.weekday() * 4 + d.month),
                          small_end=date(2025, 12, 31))
        rows += make_rows(self.start, self.end, stage="预热期", cycle="批次2", source="src2",
                           value_fn=lambda d: 3 * (100 + d.weekday() * 4 + d.month))
        rows += make_rows(date(2025, 1, 1), date(2025, 1, 1), metric="大定")
        result = forecast.build_forecast_insights(rows)
        self.assertEqual(result["as_of"], self.end)
        keys = {(p["model"], p["metric"], p["stage"], p["cycle"], p["source"]) for p in result["profiles"]}
        self.assertEqual(len(keys), 4)
        self.assertEqual({key[1] for key in keys}, {"小订数量", "留存大定", "交车锁单"})
        self.assertIn(("M1", "留存大定", "预热期", "批次2", "src2"), keys)
        self.assertTrue(all(bt["metric"] in {"小订数量", "留存大定", "交车锁单"} for bt in result["backtests"]))
        self.assertEqual(result["method"]["metrics"], ["小订数量", "留存大定", "交车锁单"])

    def test_small_orders_outside_small_stage_are_skipped(self):
        invalid = make_rows(self.start, self.end, metric="小订数量", stage="平销")
        valid = make_rows(self.start, self.end, metric="留存大定")
        result = forecast.build_forecast_insights(invalid + valid)
        self.assertFalse(any(p["metric"] == "小订数量" for p in result["profiles"]))
        self.assertTrue(any("阶段不是小订阶段" in note for note in result["notes"]))
        self.assertEqual(result["method"]["as_of_scope"], "三个目标指标中有效观测日期的全局最大日期")

    def test_small_order_future_target_must_stay_inside_confirmed_small_period(self):
        rows = make_rows(self.start, self.end, metric="小订数量", stage="小订阶段",
                         small_end=date(2024, 12, 31))
        result = forecast.build_forecast_insights(rows)
        profiles = [p for p in result["profiles"] if p["metric"] == "小订数量"]
        self.assertTrue(profiles)
        self.assertTrue(all(p["target_start"] is None and p["target_end"] is None
                            and p["baseline"] is None and p["estimate"] is None
                            for p in profiles))
        self.assertTrue(any("超出已确认的小订结束日" in p["tail_note"] for p in profiles))

    def test_backtest_prediction_does_not_use_target_or_later_values(self):
        target = date(2024, 11, 15)
        rows = make_rows(self.start, self.end)
        altered = [
            {**row, "value": row["value"] + 100_000}
            if row["date"] >= target else row
            for row in rows
        ]
        first = forecast.build_forecast_insights(rows)
        second = forecast.build_forecast_insights(altered)

        def find(result):
            return next(r for r in result["backtests"]
                        if r["grain"] == "day" and r["metric"] == "留存大定"
                        and r["target_start"] == target)
        a, b = find(first), find(second)
        self.assertEqual(a["predicted"], b["predicted"])
        self.assertEqual(a["factor"], b["factor"])
        self.assertEqual(a["train_samples"], b["train_samples"])
        self.assertNotEqual(a["actual"], b["actual"])
        self.assertLess(a["cutoff"], a["target_start"])

    def test_missing_date_is_not_filled_and_makes_period_incomplete(self):
        missing = {date(2024, 11, 15)}
        rows = make_rows(self.start, self.end, missing=missing)
        result = forecast.build_forecast_insights(rows)
        self.assertFalse(any(
            bt["grain"] == "day" and bt["target_start"] == date(2024, 11, 15)
            for bt in result["backtests"]
        ))
        self.assertFalse(any(
            bt["grain"] == "week" and bt["target_start"] == date(2024, 11, 11)
            for bt in result["backtests"]
        ))
        self.assertFalse(any(
            bt["grain"] == "month" and bt["target_start"] == date(2024, 11, 1)
            for bt in result["backtests"]
        ))

    def test_negative_actual_is_kept_in_backtest_metrics_and_zero_is_observed(self):
        target = date(2024, 11, 15)
        def values(day):
            if day == target:
                return -4
            if day == date(2024, 11, 20):
                return 0
            return 10
        result = forecast.build_forecast_insights(
            make_rows(self.start, self.end, value_fn=values)
        )
        row = next(r for r in result["backtests"]
                   if r["grain"] == "day" and r["target_start"] == target)
        self.assertEqual(row["actual"], -4)
        self.assertTrue(row["actual_has_negative"])
        self.assertIsNotNone(row["predicted"])
        self.assertEqual(row["status"], "ok")
        profile = next(p for p in result["profiles"]
                       if p["grain"] == "day" and p["metric"] == "留存大定")
        self.assertEqual(profile["test_samples"], 55)
        expected_wape = 34 / (53 * 10 + 4)
        self.assertAlmostEqual(profile["wape"], expected_wape)
        negative_baseline_row = next(r for r in result["backtests"]
                                     if r["grain"] == "day" and r["target_start"] == date(2024, 11, 16))
        self.assertEqual(negative_baseline_row["status"], "negative_baseline")
        self.assertIsNone(negative_baseline_row["predicted"])
        zero_row = next(r for r in result["backtests"]
                        if r["grain"] == "day" and r["target_start"] == date(2024, 11, 20))
        self.assertEqual(zero_row["actual"], 0)
        self.assertIsNotNone(zero_row["predicted"])

    def test_weekday_transition_multiplier_corrects_sunday_to_monday(self):
        rows = make_rows(
            self.start, self.end,
            value_fn=lambda day: 120 if day.weekday() == 6 else 100,
        )
        result = forecast.build_forecast_insights(rows)
        monday = next(r for r in result["backtests"]
                      if r["grain"] == "day" and r["target_start"] == date(2024, 12, 30))
        self.assertAlmostEqual(monday["baseline"], 120)
        self.assertAlmostEqual(monday["factor"], 100 / 120)
        self.assertAlmostEqual(monday["predicted"], 100)
        profile = next(p for p in result["profiles"] if p["grain"] == "day")
        self.assertLess(profile["wape"], profile["baseline_wape"])

    def test_zero_wape_denominator_is_explicit(self):
        summary = forecast._summary_metrics([{
            "status": "ok", "predicted": 1, "baseline": 2, "actual": 0,
        }])
        self.assertEqual(summary["evaluation_status"], "zero_actual_denominator")
        self.assertIsNone(summary["wape"])
        self.assertIsNone(summary["bias"])

    def test_cutoff_uses_data_not_wall_clock_and_requires_complete_current_period(self):
        result = forecast.build_forecast_insights(make_rows(self.start, self.end))
        self.assertEqual(result["as_of"], date(2024, 12, 31))
        day = next(p for p in result["profiles"] if p["grain"] == "day")
        self.assertEqual(day["target_start"], date(2025, 1, 1))
        self.assertEqual(day["cutoff"], date(2024, 12, 31))
        month = next(p for p in result["profiles"] if p["grain"] == "month")
        self.assertEqual(month["target_start"], date(2025, 1, 1))
        self.assertEqual(month["train_samples"], 2)
        self.assertEqual(month["status"], "ok")
        week = next(p for p in result["profiles"] if p["grain"] == "week")
        self.assertIsNone(week["target_start"])
        self.assertEqual(week["status"], "no_complete_target_period")
        self.assertEqual(week["current_to_date"]["status"], "incomplete_to_date")
        self.assertIn("暂无下一完整周预测", week["tail_note"])

    def test_estimate_with_too_few_backtests_is_marked_unverified(self):
        start, end = date(2024, 1, 1), date(2024, 2, 11)
        result = forecast.build_forecast_insights(make_rows(start, end, value_fn=lambda day: 100))
        week = next(p for p in result["profiles"] if p["grain"] == "week")
        self.assertIsNotNone(week["estimate"])
        self.assertEqual(week["test_samples"], 1)
        self.assertEqual(week["status"], "insufficient_backtest")
        self.assertIn("少于最低展示要求", week["tail_note"])

    def test_source_identity_matches_original_panel_without_silent_trimming(self):
        rows=make_rows(date(2024,1,1),date(2024,4,30),model="M1",source="source")
        rows+=make_rows(date(2024,1,1),date(2024,4,30),model=" M1",source="source ")
        result=forecast.build_forecast_insights(rows)
        self.assertEqual({(p["model"],p["source"]) for p in result["profiles"]},
                         {("M1","source"),(" M1","source ")})

    def test_metrics_have_dynamic_model_rows_and_log_callback(self):
        messages = []
        rows = make_rows(self.start, self.end, model="Dynamic", source="source-X")
        result = forecast.build_forecast_insights(rows, calendar={}, log=messages.append)
        self.assertTrue(any(p["model"] == "Dynamic" and p["source"] == "source-X" for p in result["profiles"]))
        self.assertEqual(len(messages), 1)
        self.assertIn("profiles=", messages[0])


if __name__ == "__main__":
    unittest.main()
