import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("sales_export_test", Path(__file__).resolve().parents[1] / "core" / "report_profiles.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class ReportProfileTests(unittest.TestCase):
    def test_auto_includes_retained_deposits_and_manual_filter_is_explicit(self):
        rows = [dict(metric=m, model="样例", stage="平销") for m in ("留存大定", "小订数量")]
        selected, omitted = e._selected_metrics(rows, {})
        self.assertEqual(set(selected), {"留存大定", "小订数量"})
        grouping = e._choose_grouping([dict(model="样例", brand="样例品牌")], {})
        model_map = {r["model"]: r for r in grouping["entries"]}
        self.assertEqual({r["metric"] for r in e._report_series(rows, grouping["categories"], model_map)}, set(selected))
        self.assertEqual(e._selected_metrics(rows, {"mainMetrics": ["留存大定"]}), (["留存大定"], ["小订数量"]))
        with self.assertRaisesRegex(ValueError, "不存在"):
            e._selected_metrics(rows, {"mainMetrics": ["不存在的指标"]})

    def test_headlines_require_actual_multi_model_validation_and_current_direction(self):
        base=dict(category="全部车型",metric="留存大定",stage="平销",pattern="周末/工作日（日均）",
                  typical=1.2,p25=1.1,p75=1.3,models=5,periods=10,years=3,
                  validation_status="同向",train_ratio=1.1,validation_ratio=1.2,
                  validation_models=2,validation_train_years=2,detail_sheet="周内明细")
        candidate=e._headline_findings([base])[0]
        self.assertTrue(candidate["cross_year_candidate"])
        self.assertIn("120.0%",candidate["finding"])
        self.assertFalse(e._headline_findings([dict(base,validation_models=1)])[0]["cross_year_candidate"])
        self.assertFalse(e._headline_findings([dict(base,typical=.8)])[0]["cross_year_candidate"])
        self.assertFalse(e._headline_findings([dict(base,periods=2)])[0]["cross_year_candidate"])
        self.assertEqual(e._headline_findings([dict(base,metric="大定")]),[])
        first=e._headline_findings([dict(base,metric="交车锁单",stage="首销"),base])[0]
        self.assertEqual(first["metric"],"留存大定")
        self.assertEqual(first["stage"],"平销")

    def test_negative_month_excluded_from_monthly_profile(self):
        item = dict(category="全部车型", metric="留存大定", stage="平销")
        row = dict(model="样例", metric="留存大定", stage="平销", kind="月",
                   start="2025-09-01", current=300, current_days=30,
                   current_observed=30, current_negative_days=1, status="本期含负值")
        profiles = e.build_monthly_profiles({"period_comparisons": [row]}, [item], {})
        september = next(r for r in profiles if r["month"] == 9)
        self.assertEqual(september["complete"], 0)
        self.assertIsNone(september["daymean"])
