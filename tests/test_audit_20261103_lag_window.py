"""Lag correlations must fit their complete evidence range inside UI filters."""
import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audit_lag_analysis", ROOT / "analyze_sales_patterns.py")
analysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analysis)


def make_panel(days=21):
    return [dict(model="配对车型", metric=metric, stage="平销", cycle="批次A", source="原表",
                 date=date(2025, 1, 1)+timedelta(days=i), value=float((i*7)%19+10), life=None)
            for metric in ("留存大定", "交车锁单") for i in range(days)]


class LagEvidenceWindowTests(unittest.TestCase):
    def test_common_sample_window_includes_all_three_lagged_days(self):
        rows = analysis.lock_lag_analysis(make_panel())
        self.assertEqual(len(rows), 4)
        self.assertEqual({row["pairs"] for row in rows}, {18})
        self.assertEqual({row["start"] for row in rows}, {date(2025, 1, 1)})
        self.assertEqual({row["end"] for row in rows}, {date(2025, 1, 21)})
        self.assertTrue(all(not (row["start"] >= date(2025, 1, 1) and row["end"] <= date(2025, 1, 18)) for row in rows))

    def test_pair_counts_and_correlations_keep_existing_formula(self):
        rows = analysis.lock_lag_analysis(make_panel())
        levels = [1.0, -0.3828319723362606, -0.1574525253800186, 0.41878704623447505]
        for row, expected in zip(rows, levels):
            self.assertEqual(row["pairs"], 18)
            self.assertEqual(row["change_pairs"], 17)
            self.assertAlmostEqual(row["level_corr"], expected, places=14)
            self.assertIsNotNone(row["change_corr"])

    def test_daily_change_previous_day_is_part_of_evidence(self):
        panel = [row for row in make_panel() if not (row["metric"] == "交车锁单" and row["date"] == date(2025, 1, 1))]
        rows = analysis.lock_lag_analysis(panel)
        # First usable change compares Jan3 with Jan2; Jan2 is mandatory evidence.
        self.assertEqual({row["change_pairs"] for row in rows}, {16})
        self.assertEqual({row["start"] for row in rows}, {date(2025, 1, 2)})
        self.assertEqual({row["end"] for row in rows}, {date(2025, 1, 21)})

    def test_unpaired_later_observation_does_not_extend_evidence_range(self):
        panel = make_panel()
        panel.append(dict(panel[-1], date=date(2025, 2, 1), value=999))
        self.assertEqual(analysis.lock_lag_analysis(panel), analysis.lock_lag_analysis(make_panel()))

    def test_negative_tail_does_not_enter_pairs_or_evidence_range(self):
        panel = make_panel(22)
        panel[-1]["value"] = -1
        rows = analysis.lock_lag_analysis(panel)
        self.assertEqual({row["pairs"] for row in rows}, {18})
        self.assertEqual({row["end"] for row in rows}, {date(2025, 1, 21)})

    def test_insufficient_and_empty_pair_windows_do_not_gain_samples(self):
        short = analysis.lock_lag_analysis(make_panel(5))
        self.assertTrue(all(row["pairs"] == 2 and row["level_corr"] is None for row in short))
        self.assertEqual({row["end"] for row in short}, {date(2025, 1, 5)})
        empty = analysis.lock_lag_analysis(make_panel(3))
        self.assertTrue(all(row["pairs"] == 0 and row["start"] is None and row["end"] is None for row in empty))


if __name__ == "__main__":
    unittest.main()
