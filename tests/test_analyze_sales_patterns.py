"""Numerical and boundary tests; synthetic records are not business conclusions."""
import importlib.util
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from statistics import mean

spec=importlib.util.spec_from_file_location('sales_patterns',Path(__file__).resolve().parents[1] / 'analyze_sales_patterns.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def records(a,b,fn=lambda d:100):
    return [dict(model='测试车型',date=d,metric='大定',stage='平销',cycle='平销',
                 source='实测',value=fn(d),life=None) for d in m.span(a,b)]

class Sheet:
    def __init__(self,rows): self.rows=rows
    def iter_rows(self,values_only=True): return iter(self.rows)

class Book:
    def __init__(self,small,orders):
        self.sheets={'小订及退订逐日':Sheet(small),'当前订单逐日':Sheet(orders)}
    def __getitem__(self,k): return self.sheets[k]
    def close(self): pass

class SalesPatternTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.cal=m.load_calendar()

    def test_full_history_2021_through_2026_and_holidays(self):
        p=records(date(2021,1,1),date(2026,9,15))
        r=m.analyze(p,self.cal)
        self.assertEqual({x['year'] for x in r['annual']},set(range(2021,2026)))
        self.assertGreater(len(r['holidays']),10)
        for x in r['weekly']:
            self.assertAlmostEqual(mean(x['indexes']),100)
            self.assertAlmostEqual(x['ratio'],1)
        for x in r['monthly']: self.assertAlmostEqual(x['ratio'],1)
        for x in r['annual']: self.assertEqual(x['indexes'],[100]*12)
        for x in r['holidays']:
            self.assertAlmostEqual(x['before'],1)
            self.assertAlmostEqual(x['during'],1)
            self.assertAlmostEqual(x['after'],1)

    def test_weekend_effect_exactly_two(self):
        r=m.analyze(records(date(2026,8,3),date(2026,8,9),lambda d:200 if d.weekday()>4 else 100),self.cal)
        self.assertEqual(len(r['weekly']),1)
        self.assertEqual(r['weekly'][0]['ratio'],2)

    def test_missing_is_not_zero(self):
        p=records(date(2026,8,1),date(2026,8,31))
        p=[r for r in p if r['date']!=date(2026,8,4)]
        r=m.analyze(p,self.cal)
        self.assertEqual(len(r['monthly']),0)
        self.assertNotIn(date(2026,8,3),{x['week'] for x in r['weekly']})
        p=records(date(2026,8,1),date(2026,8,31),lambda d:0 if d.day==4 else 100)
        self.assertEqual(len(m.analyze(p,self.cal)['monthly']),1)

    def test_source_switch_splits_comparison(self):
        p=records(date(2026,8,3),date(2026,8,9))
        p[0]['source']='不同来源'
        self.assertEqual(m.analyze(p,self.cal)['weekly'],[])

    def test_calendar_adjusted_workdays_and_linked_weekends(self):
        self.assertFalse(m.ordinary(date(2021,2,7),self.cal))
        self.assertEqual(self.cal['holidays'][date(2024,6,8)],'端午节')
        self.assertEqual(self.cal['holidays'][date(2023,12,30)],'元旦')
        self.assertEqual(m.analyze(records(date(2030,8,1),date(2030,8,31)),self.cal)['weekly'],[])

    def test_lifecycle_separate_from_weekday(self):
        p=records(date(2026,8,1),date(2026,8,7))
        for i,r in enumerate(p,1):
            r.update(stage='首销',cycle='2026-08-01',life=i,value=500 if i==1 else 100)
        result=m.analyze(p,self.cal)['lifecycle'][0]
        self.assertEqual(result['d1_ratio'],5)
        self.assertAlmostEqual(result['first2_share'],600/1100)

    def test_reader_zero_source_and_duplicate_guards(self):
        head=['订单分析代际名','日期','小订数量','真实逐日','小订来源','生命周期']
        row=['测试',date(2026,8,1),0,True,'原始逐日','D1']
        small=[head,row,row,['测试',date(2026,8,2),5,True,'合成曲线','D2']]
        orders=[['订单分析代际名','日期','订单阶段']]
        with patch.object(m.openpyxl,'load_workbook',return_value=Book(small,orders)):
            p,audit=m.read_panel(Path('not-read.xlsx'))
        self.assertEqual(len(p),1)
        self.assertEqual(p[0]['value'],0)
        self.assertEqual(audit['相同重复去重'],1)
        bad=list(row); bad[2]=1
        with patch.object(m.openpyxl,'load_workbook',return_value=Book([head,row,bad],orders)):
            with self.assertRaisesRegex(ValueError,'重复键冲突'):
                m.read_panel(Path('not-read.xlsx'))

    def test_retained_deposit_new_name_and_legacy_alias(self):
        small=[['订单分析代际名','日期','小订数量','真实逐日','小订来源','生命周期']]
        base=['测试',date(2026,8,1),'平销',8,'原始逐日']
        new=[['订单分析代际名','日期','订单阶段','留存大定','留存大定来源'],base]
        with patch.object(m.openpyxl,'load_workbook',return_value=Book(small,new)):
            panel,_=m.read_panel(Path('not-read.xlsx'))
        self.assertEqual([(r['metric'],r['value']) for r in panel],[('留存大定',8)])
        legacy=[['订单分析代际名','日期','订单阶段','净大定','净大定来源'],base]
        with patch.object(m.openpyxl,'load_workbook',return_value=Book(small,legacy)):
            panel,_=m.read_panel(Path('not-read.xlsx'))
        self.assertEqual([(r['metric'],r['value']) for r in panel],[('留存大定',8)])

    def test_retained_deposit_requires_matching_source_column(self):
        small=[['订单分析代际名','日期','小订数量','真实逐日','小订来源','生命周期']]
        orders=[['订单分析代际名','日期','订单阶段','留存大定'],
                ['测试',date(2026,8,1),'平销',8]]
        with patch.object(m.openpyxl,'load_workbook',return_value=Book(small,orders)):
            with self.assertRaisesRegex(ValueError,'留存大定来源'):
                m.read_panel(Path('not-read.xlsx'))
    def test_period_percentage_vs_growth_and_month_lengths(self):
        p=records(date(2025,8,1),date(2025,10,31),lambda d:200 if d.month==9 else 100)
        rows=m.period_comparisons(p,self.cal)
        sep=next(r for r in rows if r['kind']=='月' and r['start']==date(2025,9,1))
        self.assertAlmostEqual(sep['ratio'],6000/3100)
        self.assertEqual(sep['daily_ratio'],2)
        self.assertEqual(sep['transition'],'8→9月')
        self.assertEqual(sep['status'],'有效')
        # ratio=2 means 200% of previous, not 200% growth.
        daily=next(r for r in rows if r['kind']=='日' and r['start']==date(2025,9,1))
        self.assertEqual(daily['ratio'],2)

    def test_period_gaps_zero_and_partial_never_filled(self):
        p=records(date(2025,7,1),date(2025,7,31))+records(date(2025,9,1),date(2025,9,30))
        rows=m.period_comparisons(p,self.cal)
        sep=next(r for r in rows if r['kind']=='月' and r['start']==date(2025,9,1))
        self.assertEqual(sep['status'],'前期缺失或不完整')
        self.assertIsNone(sep['ratio'])
        p=records(date(2026,8,1),date(2026,8,3),lambda d:0 if d.day==1 else 100)
        rows=m.period_comparisons(p,self.cal)
        r=next(r for r in rows if r['kind']=='日' and r['start']==date(2026,8,2))
        self.assertEqual(r['status'],'前期为零')
        self.assertIsNone(r['ratio'])

    def test_metrics_stages_and_classes_not_pooled(self):
        a=records(date(2026,8,1),date(2026,8,14))
        b=records(date(2026,8,1),date(2026,8,14),lambda d:100+d.day*20)
        for r in a: r.update(brand='甲',segment='SUV',energy='纯电')
        for r in b: r.update(model='第二车型',metric='交车锁单',brand='乙',segment='轿车',energy='增程')
        summary=m.summarize_comparisons(m.period_comparisons(a+b,self.cal))
        self.assertTrue(any(r['role']=='大定' and r['category']=='甲' for r in summary))
        self.assertTrue(any(r['role']=='锁单' and r['category']=='乙' for r in summary))
        self.assertFalse(any(r['metric']=='大定' and r['category']=='乙' for r in summary))

    def test_two_day_lock_delay_same_sample_for_all_lags(self):
        start=date(2026,3,1)
        def value(d):
            t=(d-start).days
            return 100+(t*t*17+t*13)%89
        a=records(start,start+timedelta(days=59),value)
        for r in a: r['metric']='留存大定'
        b=records(start,start+timedelta(days=59),lambda d:value(d-timedelta(days=2)))
        for r in b: r['metric']='交车锁单'
        lags=m.lock_lag_analysis(a+b)
        self.assertEqual(len(lags),4)
        self.assertEqual(len({r['pairs'] for r in lags}),1)
        lag2=next(r for r in lags if r['lag']==2)
        self.assertAlmostEqual(lag2['level_corr'],1)
        self.assertAlmostEqual(lag2['change_corr'],1)
        self.assertLess(next(r for r in lags if r['lag']==0)['level_corr'],1)

    def test_cross_year_period_and_leap_year(self):
        p=records(date(2023,12,1),date(2024,3,1))
        rows=m.period_comparisons(p,self.cal)
        jan=next(r for r in rows if r['kind']=='月' and r['start']==date(2024,1,1))
        feb=next(r for r in rows if r['kind']=='月' and r['start']==date(2024,2,1))
        self.assertEqual(jan['ratio'],1)
        self.assertAlmostEqual(feb['ratio'],29/31)
        self.assertEqual(feb['daily_ratio'],1)


    def test_full_zero_year_and_zero_months_remain_visible(self):
        p=records(date(2024,1,1),date(2024,12,31),lambda d:0)
        result=m.analyze(p,self.cal)
        self.assertEqual(len(result['monthly']),12)
        self.assertTrue(all(row['ratio'] is None and row['status']=='月内前期日均为零'
                            for row in result['monthly']))
        self.assertEqual(len(result['annual']),1)
        annual=result['annual'][0]
        self.assertEqual(annual['indexes'],[None]*12)
        self.assertEqual(annual['status'],'全年日均为零')

    def test_negative_month_values_keep_sums_but_suppress_both_ratios(self):
        p=records(date(2025,8,1),date(2025,10,31))
        next(r for r in p if r['date']==date(2025,9,15))['value']=-1
        rows=m.period_comparisons(p,self.cal)
        september=next(r for r in rows if r['kind']=='月' and r['start']==date(2025,9,1))
        october=next(r for r in rows if r['kind']=='月' and r['start']==date(2025,10,1))
        self.assertEqual(september['status'],'本期含负值')
        self.assertEqual(september['current_negative_days'],1)
        self.assertEqual(september['current'],2899)
        self.assertIsNone(september['ratio'])
        self.assertIsNone(september['daily_ratio'])
        self.assertEqual(october['status'],'前期含负值')
        self.assertEqual(october['previous_negative_days'],1)
        self.assertEqual(october['previous'],2899)
        self.assertIsNone(october['ratio'])

    def test_negative_lock_and_deposit_values_use_common_nonnegative_dates(self):
        start=date(2026,1,1)
        deposits=records(start,start+timedelta(days=39))
        for row in deposits:
            row['metric']='留存大定'
        locks=records(start,start+timedelta(days=39))
        deposits[10]['value']=-5
        locks[20]['value']=-3
        for row in locks:
            row['metric']='交车锁单'
        rows=m.lock_lag_analysis(deposits+locks)
        self.assertEqual(len(rows),4)
        self.assertEqual({row['pairs'] for row in rows},{32})
        self.assertEqual({row['change_pairs'] for row in rows},{29})

    def test_gross_deposit_never_drives_lock_lag_pairing(self):
        start=date(2026,1,1)
        gross=records(start,start+timedelta(days=20))
        locks=records(start,start+timedelta(days=20))
        for row in locks:
            row['metric']='交车锁单'
        self.assertEqual(m.lock_lag_analysis(gross+locks), [])

    def test_period_calendar_ranges_are_scanned_once_across_models(self):
        start,end=date(2025,7,1),date(2025,9,30)
        first=records(start,end)
        second=records(start,end)
        for row in second:
            row['model']='第二车型'
        real_span=m.span
        scanned=[]
        def tracking_span(a,b):
            scanned.append((a,b))
            return real_span(a,b)
        with patch.object(m,'span',side_effect=tracking_span):
            rows=m.period_comparisons(first+second,self.cal)
        intervals={(row['previous_start'],row['end']) for row in rows}
        self.assertEqual(len(scanned),2*len(intervals))
        self.assertLess(len(scanned),2*len(rows))

    def test_main_preflight_names_missing_input_without_touching_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            script=root/'analyze_sales_patterns.py'
            script.parent.mkdir(parents=True,exist_ok=True)
            required=[
                root/'core'/'china_calendar.py',
                root/'core'/'data_paths.py',
                script.with_name('export_excel_openpyxl.py'),
                script.with_name('report_config.json'),
                script.with_name('report_rules.py'),
            ]
            for path in required:
                path.parent.mkdir(parents=True,exist_ok=True)
                path.touch()
            (root/'core'/'data_paths.py').write_text(
                'def orders_input_directory(project_root):\n    return project_root / "input_file"\n',
                encoding='utf-8')
            missing=root/'missing.xlsx'
            with patch.object(m,'ROOT',root),patch.object(m,'SCRIPT_PATH',script),\
                 patch.object(sys,'argv',['analyze_sales_patterns.py','--input',str(missing)]):
                with self.assertRaisesRegex(FileNotFoundError,'输入工作簿不存在'):
                    m.main()
            self.assertFalse((root/'output_file').exists())

    def test_main_refuses_input_that_is_the_output_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            script=root/'analyze_sales_patterns.py'
            script.parent.mkdir(parents=True,exist_ok=True)
            for path in (
                root/'core'/'china_calendar.py',
                root/'core'/'data_paths.py',
                script.with_name('export_excel_openpyxl.py'),
                script.with_name('report_config.json'),
                script.with_name('report_rules.py'),
            ):
                path.parent.mkdir(parents=True,exist_ok=True)
                path.touch()
            (root/'core'/'data_paths.py').write_text(
                'def orders_input_directory(project_root):\n    return project_root / "input_file"\n',
                encoding='utf-8')
            final=root/'output_file'/'鸿蒙智行销量规律分析.html'
            final.parent.mkdir(parents=True)
            final.write_bytes(b'preserve source')
            with patch.object(m,'ROOT',root),patch.object(m,'SCRIPT_PATH',script),\
                 patch.object(sys,'argv',['analyze_sales_patterns.py','--input',str(final),
                                          '--out',str(root/'ignored-folder')]):
                with self.assertRaisesRegex(ValueError,'输入文件与固定网页输出文件相同'):
                    m.main()
            self.assertEqual(final.read_bytes(),b'preserve source')
            self.assertFalse((root/'ignored-folder').exists())


class UnifiedDailyTests(unittest.TestCase):
    def read(self, rows, models=(), headers=None):
        base = ['日期','订单分析代际名','订单阶段','来源类型','来源文件','来源Sheet',
                '生命周期','历史传播名','小订数量','大定','留存大定','交车锁单']
        head = headers if headers is not None else list(dict.fromkeys(base+[k for r in rows for k in r]))
        model_head = ['订单分析代际名','历史传播名','首销开始','首销结束','小订开始','小订结束','品牌','产品档位','能源类型']
        model_head = list(dict.fromkeys(model_head+[k for r in models for k in r]))
        book = Book([], [])
        book.sheets = {
            m.UNIFIED_DAILY_SHEET: Sheet([head]+[[r.get(k) for k in head] for r in rows]),
            '车型基本信息': Sheet([model_head]+[[r.get(k) for k in model_head] for r in models]),
            '说明与来源': Sheet([['项目','内容'],['数据判定日期','2025-12-31']]),
        }
        book.sheetnames = list(book.sheets)
        with patch.object(m.openpyxl, 'load_workbook', return_value=book):
            return m.read_panel(Path('not-read.xlsx'))

    def row(self, **changes):
        row = dict(日期=date(2025,8,1), 订单分析代际名='测试车型', 订单阶段='首销',
                   来源类型='首销订单', 来源文件='鸿蒙智行首销期订单节奏.xlsx',
                   来源Sheet='测试车型by天', 生命周期='D1')
        row.update(changes)
        return row

    def test_unified_metrics_zero_snapshots_future_and_no_net_substitution(self):
        rows = [self.row(大定=100,留存大定=0,交车锁单=20),
                self.row(日期=date(2025,8,2),大定=80,生命周期='D2'),
                self.row(来源类型='首销分时累计',来源Sheet='测试车型by时',交车锁单=999),
                self.row(日期=date(2026,1,1),留存大定=1000)]
        panel,audit = self.read(rows)
        net = [r for r in panel if r['metric']=='留存大定']
        self.assertEqual([r['value'] for r in net],[0])
        self.assertEqual([r['value'] for r in panel if r['metric']=='交车锁单'],[20])
        self.assertEqual(audit['累计快照或参考曲线排除'],1)
        self.assertEqual(audit['未来或超过数据判定日期排除'],1)
        self.assertEqual(net[0]['cycle'],'2025-08-01')
        self.assertIn('测试车型by天',net[0]['source'])

    def test_unified_small_priority_and_stage_normalization(self):
        rows = [self.row(订单阶段='小订',来源类型='历史小订',来源文件='整理表.xlsx',小订数量=50),
                self.row(订单阶段='小订',来源类型='逐日小订',来源文件='鸿蒙智行小订退订分析.xlsx',小订数量=60),
                self.row(订单阶段='小订',来源类型='逐日小订',来源文件='鸿蒙智行小订选配比例分析.xlsx',小订数量=0)]
        panel,audit = self.read(rows)
        self.assertEqual(len(panel),1)
        self.assertEqual(panel[0]['value'],0)
        self.assertEqual(panel[0]['stage'],'小订阶段')
        self.assertEqual(audit['跨来源候选未累加'],2)
        reverse,_ = self.read(list(reversed(rows)))
        self.assertEqual(panel[0]['source'],reverse[0]['source'])
        self.assertEqual(panel[0]['value'],reverse[0]['value'])

    def test_unified_finished_launch_prefers_history_and_active_prefers_launch(self):
        rows=[self.row(大定=100),self.row(来源类型='历史首销',来源文件='整理表.xlsx',大定=200)]
        ended=[dict(订单分析代际名='测试车型',首销开始='2025-08-01',首销结束='2025-09-01')]
        active=[dict(订单分析代际名='测试车型',首销开始='2025-08-01',首销结束='2026-01-01')]
        self.assertEqual(self.read(rows,ended)[0][0]['value'],200)
        self.assertEqual(self.read(rows,active)[0][0]['value'],100)

    def test_unified_regular_lock_source_priority(self):
        rows=[self.row(订单阶段='平销',交车锁单=25),
              self.row(订单阶段='平销',来源类型='平销锁单',来源文件='鸿蒙智行锁单选配比例分析.xlsx',交车锁单=0)]
        panel,_=self.read(rows)
        self.assertEqual(len(panel),1)
        self.assertEqual(panel[0]['value'],0)
        self.assertEqual(panel[0]['cycle'],'平销')

    def test_unified_duplicate_and_equal_priority_conflicts(self):
        row=self.row(留存大定=10)
        panel,audit=self.read([row,row.copy()])
        self.assertEqual(len(panel),1)
        self.assertEqual(audit['相同重复去重'],1)
        with self.assertRaisesRegex(ValueError,'重复键冲突'):
            self.read([row,self.row(留存大定=11)])
        with self.assertRaisesRegex(ValueError,'同优先级来源冲突'):
            self.read([row,self.row(来源Sheet='第二批by天',留存大定=11)])

    def test_unified_matches_multiple_launches_and_preserves_conflicting_attributes(self):
        models=[dict(订单分析代际名='测试车型',历史传播名='上半年款',首销开始='2025-01-01',首销结束='2025-02-01',能源类型='纯电'),
                dict(订单分析代际名='测试车型',历史传播名='下半年款',首销开始='2025-08-01',首销结束='2025-09-01',能源类型='增程')]
        rows=[self.row(日期=date(2025,1,2),生命周期=None,历史传播名='上半年款',留存大定=10),
              self.row(日期=date(2025,8,2),生命周期=None,历史传播名='下半年款',留存大定=20)]
        panel,audit=self.read(rows,models)
        self.assertEqual({r['cycle'] for r in panel},{'2025-01-01','2025-08-01'})
        self.assertEqual({r['life'] for r in panel},{2})
        self.assertEqual({r['energy'] for r in panel},{'映射冲突'})
        self.assertEqual(audit['属性冲突车型数'],1)

    def test_unified_legacy_net_alias_and_negative_values(self):
        row=self.row(净大定=-2)
        headers=[k for k in row]+['小订数量','大定','交车锁单']
        panel,audit=self.read([row],headers=headers)
        self.assertEqual([(r['metric'],r['value']) for r in panel],[('留存大定',-2)])
        self.assertEqual(audit['留存大定负值不参与倍率'],1)

    def test_unified_missing_source_columns_fail_clearly(self):
        row=self.row(留存大定=10)
        with self.assertRaisesRegex(ValueError,'来源Sheet'):
            self.read([row],headers=[k for k in row if k!='来源Sheet'])


    def resolved(self, rows, models=()):
        headers = ['代际名','二级代际名','日期','订单阶段','生命周期','字段来源',
                   '小订数量','大定','留存大定','小转大','直接大定','交车锁单']
        # The production reader must not infer an order stage from a raw label
        # when model boundaries are absent.  Most resolved-fixture tests are
        # about provenance/deduplication, so give their default model a real
        # post-launch window explicitly; tests that exercise missing metadata
        # pass their own model rows.
        if not models:
            models = [dict(代际名='新代际',小订开始='2025-08-01',小订结束='2025-08-31',
                           首销开始='2025-01-01',首销结束='2025-07-31')]
        return self.read(rows,models,headers=headers)

    def resolved_row(self, **changes):
        row = dict(代际名='新代际', 日期=date(2025,8,1), 订单阶段='平销',
                   字段来源='大定/留存大定=大定选配.xlsx｜新代际by天；交车锁单=锁单选配.xlsx｜新代际by天',
                   留存大定=10,交车锁单=15)
        row.update(changes)
        return row

    NEW_HEADERS = ['代际名','二级代际名','日期','订单阶段','生命周期','日期状态',
                   '小订','小订数量','小订退订','小转大','直接大定','大定',
                   '留存大定','净大定','交车锁单','字段来源','首销分时核对']

    def new_read(self, rows, models=(),判定日='2025-12-31', headers=None):
        headers = headers or self.NEW_HEADERS
        if not models:
            models = [dict(代际名='新代际',二级代际名='纯电版',小订开始='2025-08-01',
                           小订结束='2025-08-31',首销开始='2025-01-01',首销结束='2025-12-31')]
        model_head = ['代际名','二级代际名','首销开始','首销结束','小订开始','小订结束',
                      '品牌','产品档位','能源类型']
        model_head = list(dict.fromkeys(model_head + [k for r in models for k in r]))
        book = Book([], [])
        book.sheets = {
            m.UNIFIED_DAILY_SHEET: Sheet([headers] + [[r.get(k) for k in headers] for r in rows]),
            '车型基本信息': Sheet([model_head] + [[r.get(k) for k in model_head] for r in models]),
            '说明与来源': Sheet([['项目','内容'],['数据判定日期',判定日]]),
        }
        book.sheetnames = list(book.sheets)
        with patch.object(m.openpyxl, 'load_workbook', return_value=book):
            return m.read_panel(Path('not-read.xlsx'))

    def new_row(self, **changes):
        row = dict(代际名='新代际',二级代际名='纯电版',日期=date(2025,8,1),订单阶段='平销',
                   生命周期=None,日期状态='已结束日',小订=11,小订数量=99,
                   小订退订=100,小转大=None,直接大定=None,大定=88,
                   留存大定=10,净大定=99,交车锁单=7,首销分时核对=999,
                   字段来源='小订=小订.xlsx｜by天；大定/留存大定/净大定=大定.xlsx｜by天；'
                         '交车锁单=锁单.xlsx｜by天')
        row.update(changes)
        return row

    def test_prelaunch_qualifier_preserves_small_orders_without_relabeling_deposits(self):
        models = [dict(代际名='新代际',二级代际名='纯电版',小订开始='2025-08-01',
                       小订结束='2025-08-10',首销开始='2025-08-10',首销结束='2025-09-10')]
        rows = [self.new_row(订单阶段='小订/首销前',生命周期='D1',小订=0),
                self.new_row(日期=date(2025,8,2),订单阶段='首销前',小订=12)]
        panel, audit = self.new_read(rows, models)
        self.assertEqual([(r['metric'],r['value'],r['stage'],r['life']) for r in panel],
                         [('小订数量',0,'小订阶段',1),('小订数量',12,'小订阶段',2)])
        self.assertEqual(audit['留存大定阶段不明确排除'],2)
        self.assertEqual(audit['交车锁单阶段不明确排除'],2)

    def test_new_schema_metric_aliases_prefer_new_values_and_keep_zero_negative_missing(self):
        rows = [
            self.new_row(日期=date(2025,8,1),小订=11,小订数量=99,留存大定=10,净大定=99,
                         交车锁单=7),
            self.new_row(日期=date(2025,8,2),小订=0,小订数量=88,留存大定=0,净大定=77,
                         交车锁单=-2),
            self.new_row(日期=date(2025,8,3),小订=None,小订数量=66,留存大定=None,净大定=55,
                         交车锁单=None),
        ]
        panel, audit = self.new_read(rows)
        values = {(r['date'], r['metric']): r['value'] for r in panel}
        self.assertEqual(values[(date(2025,8,1),'小订数量')], 11)
        self.assertEqual(values[(date(2025,8,1),'留存大定')], 10)
        self.assertEqual(values[(date(2025,8,1),'交车锁单')], 7)
        self.assertEqual(values[(date(2025,8,2),'小订数量')], 0)
        self.assertEqual(values[(date(2025,8,2),'留存大定')], 0)
        self.assertEqual(values[(date(2025,8,2),'交车锁单')], -2)
        self.assertNotIn((date(2025,8,3),'小订数量'), values)
        self.assertNotIn((date(2025,8,3),'留存大定'), values)
        self.assertNotIn((date(2025,8,3),'交车锁单'), values)
        self.assertEqual(audit.get('小订数量负值不参与倍率', 0), 0)
        self.assertEqual(audit['交车锁单负值不参与倍率'], 1)

    def test_new_schema_value_and_source_aliases_cross_match(self):
        cases = [
            ('新值列+旧来源名', self.new_row(
                日期=date(2025,8,4),小订=21,小订数量=77,留存大定=31,净大定=71,
                字段来源='小订数量=旧小订.xlsx｜by天；净大定=旧大定.xlsx｜by天；'
                          '交车锁单=锁单.xlsx｜by天'), self.NEW_HEADERS,
             {'小订数量':21,'留存大定':31}),
            ('旧值列+新来源名', self.new_row(
                日期=date(2025,8,5),小订=None,小订数量=22,留存大定=None,净大定=32,
                字段来源='小订=新小订.xlsx｜by天；留存大定=新大定.xlsx｜by天；'
                          '交车锁单=锁单.xlsx｜by天'),
             [h for h in self.NEW_HEADERS if h not in ('小订','留存大定')],
             {'小订数量':22,'留存大定':32}),
        ]
        for label, row, headers, expected in cases:
            with self.subTest(label=label):
                panel, _ = self.new_read([row], headers=headers)
                values = {r['metric']: r['value'] for r in panel}
                for metric, value in expected.items():
                    self.assertEqual(values[metric], value)

    def test_new_schema_alias_source_conflict_is_rejected(self):
        for source in ('小订=来源A；小订数量=来源B', '留存大定=来源A；净大定=来源B'):
            row = self.new_row(字段来源=source)
            with self.assertRaisesRegex(ValueError, '字段来源冲突'):
                self.new_read([row])

    def test_new_schema_legacy_metric_aliases_remain_compatible(self):
        headers = [h for h in self.NEW_HEADERS if h not in ('小订','留存大定')]
        row = self.new_row(小订=None,留存大定=None,小订数量=14,净大定=13,
                           字段来源='小订数量=旧小订.xlsx｜by天；净大定=旧大定.xlsx｜by天；'
                                 '交车锁单=锁单.xlsx｜by天')
        panel, _ = self.new_read([row], headers=headers)
        values = {r['metric']: r['value'] for r in panel}
        self.assertEqual(values['小订数量'], 14)
        self.assertEqual(values['留存大定'], 13)
        self.assertEqual(values['交车锁单'], 7)

    def test_new_schema_status_and_cutoff_require_finished_before_judgement_date(self):
        rows = [
            self.new_row(日期=date(2025,8,1),日期状态='已结束日'),
            self.new_row(日期=date(2025,8,2),日期状态='当前日'),
            self.new_row(日期=date(2025,8,2),日期状态='未结束日'),
            self.new_row(日期=date(2025,8,2),日期状态='未知状态'),
            self.new_row(日期=date(2025,8,2),日期状态=None),
            self.new_row(日期=date(2025,8,3),日期状态='已结束日'),
            self.new_row(日期=date(2025,8,4),日期状态='已结束日'),
        ]
        panel, audit = self.new_read(rows,判定日='2025-08-03')
        self.assertEqual({r['date'] for r in panel}, {date(2025,8,1)})
        self.assertEqual(audit['未结束或未知日期状态排除'], 4)
        self.assertEqual(audit['数据判定当日未完整排除'], 1)
        self.assertEqual(audit['未来或超过数据判定日期排除'], 1)

    def test_new_schema_unknown_stage_is_excluded_and_reference_columns_do_not_change_net_lock(self):
        rows = [
            self.new_row(日期=date(2025,8,1),订单阶段='未知',小订退订=100,首销分时核对=999,
                         留存大定=12,净大定=12,交车锁单=8),
            self.new_row(日期=date(2025,8,2),订单阶段=None,小订退订=100,首销分时核对=999,
                         留存大定=12,净大定=12,交车锁单=8),
            self.new_row(日期=date(2025,8,3),订单阶段='平销',小订退订=100,首销分时核对=999,
                         留存大定=12,净大定=12,交车锁单=8),
        ]
        panel, _ = self.new_read(rows)
        # Raw labels are audit hints only.  All three rows have an order value
        # and fall in the fixture's launch window, so they are retained even
        # when the source label is unknown/blank.  Reference columns still do
        # not become metrics.
        self.assertEqual({r['date'] for r in panel},
                         {date(2025,8,1),date(2025,8,2),date(2025,8,3)})
        self.assertEqual({r['stage'] for r in panel}, {'小订阶段','首销'})
        self.assertEqual({r['metric'] for r in panel},
                         {'小订数量','大定','留存大定','交车锁单'})
        self.assertNotIn('小订退订', {r['metric'] for r in panel})
        self.assertNotIn('首销分时核对', {r['metric'] for r in panel})

    def test_new_schema_composite_stage_uses_metric_specific_windows_and_secondary_model(self):
        row = self.new_row(二级代际名='纯电版',订单阶段='小订/首销',日期=date(2025,9,1),
                           生命周期='D32',小订=30,小订数量=None,留存大定=10,净大定=None,
                           交车锁单=15,
                           字段来源='小订=小订.xlsx｜by天；留存大定=首销.xlsx｜by天；'
                                 '交车锁单=首销.xlsx｜by天')
        models = [dict(代际名='新代际',二级代际名='纯电版',小订开始='2025-09-01',小订结束='2025-09-30',
                       首销开始='2025-08-01',首销结束='2025-09-30',品牌='品牌甲',
                       产品档位='SUV',能源类型='纯电')]
        panel, audit = self.new_read([row], models)
        small = next(r for r in panel if r['metric']=='小订数量')
        net = next(r for r in panel if r['metric']=='留存大定')
        lock = next(r for r in panel if r['metric']=='交车锁单')
        self.assertEqual((small['model'], small['stage'], small['cycle'], small['life']),
                         ('纯电版','小订阶段','2025-09-01',1))
        self.assertEqual((net['stage'], net['cycle'], net['life']),
                         ('首销','2025-08-01',32))
        self.assertEqual((lock['stage'], lock['cycle'], lock['life']),
                         ('首销','2025-08-01',32))
        self.assertEqual((small['brand'], small['segment'], small['energy']), ('品牌甲','SUV','纯电'))
        self.assertEqual(audit['复合阶段按指标拆分'], 3)

    def test_new_schema_rebuilds_composite_stage_from_date_and_present_fields(self):
        models = [dict(代际名='新代际',二级代际名='纯电版',小订开始='2025-08-01',
                       小订结束='2025-08-05',首销开始='2025-08-05',首销结束='2025-08-07')]
        rows = [
            # Raw labels are deliberately wrong: the date and fields are the
            # source of truth for the derived stage.
            self.new_row(日期=date(2025,8,1),订单阶段='平销',生命周期=None,
                         小订=10,留存大定=20,交车锁单=8),
            self.new_row(日期=date(2025,8,5),订单阶段='首销前',生命周期=None,
                         小订=11,留存大定=21,交车锁单=9),
            self.new_row(日期=date(2025,8,7),订单阶段='小订',生命周期=None,
                         小订=None,留存大定=22,交车锁单=10),
            self.new_row(日期=date(2025,8,8),订单阶段='首销',生命周期=None,
                         小订=None,留存大定=23,交车锁单=11),
        ]
        panel, audit = self.new_read(rows, models)
        stage_by_date = {(r['date'], r['metric']): r['stage'] for r in panel}
        self.assertEqual(stage_by_date[(date(2025,8,1),'小订数量')], '小订阶段')
        self.assertNotIn((date(2025,8,1),'留存大定'), stage_by_date)
        self.assertEqual(stage_by_date[(date(2025,8,5),'小订数量')], '小订阶段')
        self.assertEqual(stage_by_date[(date(2025,8,5),'留存大定')], '首销')
        self.assertEqual(stage_by_date[(date(2025,8,7),'留存大定')], '首销')
        self.assertEqual(stage_by_date[(date(2025,8,8),'留存大定')], '平销')
        flat = next(r for r in panel if r['date'] == date(2025,8,8) and r['metric'] == '留存大定')
        self.assertEqual((flat['launch_start'], flat['launch_end']),
                         (date(2025,8,5), date(2025,8,7)))
        self.assertEqual(audit['复合阶段按指标拆分'], 5)
        self.assertEqual(audit['阶段标签与日期字段推导不一致'], 4)

    def test_new_schema_same_model_batches_match_small_and_order_windows_independently(self):
        # The same model name can have overlapping generations whose small
        # order and launch windows do not start on the same day.  At 8/7 the
        # small-order value belongs to batch B while the order values still
        # belong to batch A.  A single raw-label-based match would lose the
        # small value or assign both metrics to one batch.
        models = [
            dict(代际名='新代际',二级代际名='批次A',小订开始='2025-08-01',小订结束='2025-08-03',
                 首销开始='2025-08-01',首销结束='2025-08-20'),
            dict(代际名='新代际',二级代际名='批次B',小订开始='2025-08-05',小订结束='2025-08-10',
                 首销开始='2025-08-10',首销结束='2025-08-20'),
        ]
        row = self.new_row(二级代际名=None,日期=date(2025,8,7),订单阶段='小订/首销',生命周期=None,
                           小订=11,小订数量=None,大定=None,小转大=None,直接大定=None,
                           留存大定=21,净大定=None,交车锁单=9,
                           字段来源='小订=小订.xlsx｜by天；留存大定=首销.xlsx｜by天；'
                                 '交车锁单=首销.xlsx｜by天')
        panel, _ = self.new_read([row], models)
        small = next(r for r in panel if r['metric']=='小订数量')
        net = next(r for r in panel if r['metric']=='留存大定')
        lock = next(r for r in panel if r['metric']=='交车锁单')
        self.assertEqual((small['stage'],small['cycle'],small['life']),
                         ('小订阶段','2025-08-05',3))
        self.assertEqual((net['stage'],net['cycle'],net['life']),
                         ('首销','2025-08-01',7))
        self.assertEqual((lock['stage'],lock['cycle'],lock['life']),
                         ('首销','2025-08-01',7))

    def test_new_schema_missing_launch_boundary_is_unknown_but_small_order_is_kept(self):
        models = [dict(代际名='新代际',二级代际名='纯电版',小订开始='2025-08-01',
                       小订结束=None,首销开始='2025-08-05',首销结束=None)]
        row = self.new_row(日期=date(2025,8,5),订单阶段='首销',生命周期=None,
                           小订=11,留存大定=21,交车锁单=9)
        panel, _ = self.new_read([row], models)
        self.assertEqual({r['metric'] for r in panel}, {'小订数量'})
        self.assertEqual(panel[0]['stage'], '小订阶段')

    def test_resolved_sources_are_metric_specific_and_values_are_not_reselected(self):
        panel,audit=self.resolved([self.resolved_row(大定=12)])
        net=next(r for r in panel if r['metric']=='留存大定')
        lock=next(r for r in panel if r['metric']=='交车锁单')
        self.assertEqual(net['value'],10)
        self.assertEqual(lock['value'],15)
        self.assertEqual(net['source'],'大定选配.xlsx｜新代际by天')
        self.assertEqual(lock['source'],'锁单选配.xlsx｜新代际by天')
        self.assertEqual(audit['字段级来源表已识别'],1)

    def test_resolved_secondary_models_keep_distinct_values_and_properties(self):
        models=[dict(代际名='新代际',二级代际名='增程版',品牌='品牌甲',产品档位='SUV',能源类型='增程',
                     小订开始='2025-08-01',小订结束='2025-08-31',首销开始='2025-01-01',首销结束='2025-07-31'),
                dict(代际名='新代际',二级代际名='纯电版',品牌='品牌甲',产品档位='SUV',能源类型='纯电',
                     小订开始='2025-08-01',小订结束='2025-08-31',首销开始='2025-01-01',首销结束='2025-07-31')]
        panel,audit=self.resolved([self.resolved_row(二级代际名='增程版'),
                                   self.resolved_row(二级代际名='纯电版',留存大定=20)],models)
        self.assertEqual({r['model'] for r in panel},{'增程版','纯电版'})
        self.assertEqual({r['model']:r['energy'] for r in panel},{'增程版':'增程','纯电版':'纯电'})
        self.assertEqual(audit['属性冲突车型数'],0)

    def test_resolved_multiple_undated_model_rows_are_not_first_row_wins(self):
        models = [dict(代际名='新代际',二级代际名='批次A'),
                  dict(代际名='新代际',二级代际名='批次B')]
        with self.assertRaisesRegex(ValueError,'车型阶段日期冲突'):
            self.resolved([self.resolved_row()], models)

    def test_resolved_composite_stage_uses_each_metric_window(self):
        row=self.resolved_row(订单阶段='小订/首销',日期=date(2025,9,1),生命周期='D32',小订数量=30,
                             字段来源='小订数量=小订.xlsx｜by天；大定/留存大定/交车锁单=首销.xlsx｜by天')
        models=[dict(代际名='新代际',小订开始='2025-09-01',小订结束='2025-09-30',
                     首销开始='2025-08-01',首销结束='2025-09-30')]
        panel,_=self.resolved([row],models)
        small=next(r for r in panel if r['metric']=='小订数量')
        net=next(r for r in panel if r['metric']=='留存大定')
        self.assertEqual((small['stage'],small['cycle'],small['life']),('小订阶段','2025-09-01',1))
        self.assertEqual((net['stage'],net['cycle'],net['life']),('首销','2025-08-01',32))
        regular_models=[dict(代际名='新代际',小订开始='2025-08-01',小订结束='2025-08-31',
                             首销开始='2025-01-01',首销结束='2025-07-31')]
        regular,_=self.resolved([self.resolved_row(订单阶段='小订/平销',小订数量=0,
                                字段来源='小订数量=小订.xlsx｜by天；留存大定=大定.xlsx｜by天；交车锁单=锁单.xlsx｜by天')],
                                regular_models)
        self.assertEqual({r['stage'] for r in regular},{'小订阶段','平销'})
        outside,_=self.resolved([self.resolved_row(订单阶段='首销',日期=date(2025,10,1),生命周期='D62',
                               小订数量=30,字段来源='小订数量=小订.xlsx｜by天；留存大定=首销.xlsx｜by天')],models)
        self.assertNotIn('小订数量', {r['metric'] for r in outside})

    def test_resolved_missing_metric_source_is_not_borrowed_and_zero_is_preserved(self):
        row=self.resolved_row(留存大定=0,交车锁单=0,字段来源='留存大定=大定.xlsx｜by天')
        panel,audit=self.resolved([row])
        self.assertEqual([(r['metric'],r['value']) for r in panel],[('留存大定',0)])
        self.assertEqual(audit['交车锁单字段来源排除'],1)
        empty,_=self.resolved([self.resolved_row(留存大定=None,交车锁单=None)])
        self.assertEqual(empty,[])

    def test_resolved_future_snapshots_and_duplicate_conflicts(self):
        rows=[self.resolved_row(), self.resolved_row(日期=date(2026,1,1)),
              self.resolved_row(日期=date(2025,8,2),字段来源='留存大定/交车锁单=首销.xlsx｜分时累计')]
        panel,audit=self.resolved(rows)
        self.assertEqual(len(panel),2)
        self.assertEqual(audit['未来或超过数据判定日期排除'],1)
        with self.assertRaisesRegex(ValueError,'字段来源冲突'):
            self.resolved([self.resolved_row(字段来源='留存大定=a；留存大定=b')])
        with self.assertRaisesRegex(ValueError,'重复键冲突'):
            self.resolved([self.resolved_row(),self.resolved_row(留存大定=99)])


class HolidayScopeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.start,self.end=date(2025,4,10),date(2025,4,12)
        self.cal=dict(years={2025},events=[(2025,'测试节',self.start,self.end)],
                      holidays={d:'测试节' for d in m.span(self.start,self.end)},work=set())

    def observations(self,model,scale,during):
        return [dict(model=model,metric='留存大定',stage='平销',cycle='平销',source='实测',life=None,
                     date=d,value=scale*(d.weekday()+1)*(during if self.start<=d<=self.end else 1))
                for d in m.span(self.start-timedelta(days=40),self.end+timedelta(days=40))]

    def test_daily_components_reconcile_model_indexes_and_volume_weighted_scope(self):
        panel=self.observations('A',100,2)+self.observations('B',900,1)
        panel += [dict(r,metric='交车锁单',value=r['value']*3) for r in self.observations('A',100,4)]
        rows=m.analyze(panel,self.cal)['holidays']
        self.assertEqual(len(rows),3)
        net=[r for r in rows if r['metric']=='留存大定']
        by_date={}
        for row in rows:
            self.assertEqual(len(row['daily']),17)
            phases={'before':[],'during':[],'after':[]}
            for daily in row['daily']:
                day=daily['date']; phase='before' if day<self.start else 'after' if day>self.end else 'during'
                phases[phase].append(daily['actual']/daily['expected'])
            for phase,values in phases.items(): self.assertAlmostEqual(mean(values),row[phase])
        for row in net:
            for daily in row['daily']:
                values=by_date.setdefault(daily['date'],[0,0])
                values[0]+=daily['actual'];values[1]+=daily['expected']
        scope=mean(actual/expected for d,(actual,expected) in by_date.items() if self.start<=d<=self.end)
        self.assertAlmostEqual(scope,1.1)
        self.assertAlmostEqual(mean(r['during'] for r in net),1.5)
        self.assertEqual(next(r['during'] for r in rows if r['metric']=='交车锁单'),4)

    def test_zero_actual_is_valid_but_missing_or_negative_target_is_not(self):
        zero=self.observations('零实际',100,0)
        missing=[r for r in self.observations('缺日',200,1) if r['date']!=self.start]
        negative=self.observations('负值',300,1)
        next(r for r in negative if r['date']==self.start)['value']=-1
        rows=m.analyze(zero+missing+negative,self.cal)['holidays']
        self.assertEqual([r['model'] for r in rows],['零实际'])
        self.assertEqual(rows[0]['during'],0)
        self.assertTrue(all(d['actual']==0 and d['expected']>0 for d in rows[0]['daily']
                            if self.start<=d['date']<=self.end))


class WebpageLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.report=self.root/'中文 报告 #1.html'
        self.report.write_text('<!doctype html>',encoding='utf-8')

    def test_windows_uses_native_path_and_leaves_browser_choice_to_system(self):
        with patch.object(m.sys,'platform','win32'), \
             patch.object(m.os,'startfile',create=True) as startfile, \
             patch.object(m.webbrowser,'open_new_tab') as browser, patch.object(m,'log'):
            self.assertTrue(m.open_generated_webpage(self.report))
            startfile.assert_called_once_with(str(self.report))
            browser.assert_not_called()

    def test_windows_open_failure_does_not_select_another_browser_or_change_report(self):
        original=self.report.read_bytes()
        with patch.object(m.sys,'platform','win32'), \
             patch.object(m.os,'startfile',side_effect=OSError('no association'),create=True), \
             patch.object(m.webbrowser,'open_new_tab') as browser, patch.object(m,'log') as log:
            self.assertFalse(m.open_generated_webpage(self.report))
            browser.assert_not_called()
            self.assertIn('请手动打开',log.call_args.args[0])
            self.assertEqual(self.report.read_bytes(),original)

    def test_other_systems_use_default_browser_with_encoded_file_url(self):
        for result in (True,False):
            with self.subTest(result=result), patch.object(m.sys,'platform','linux'), \
                 patch.object(m.os,'startfile',create=True) as startfile, \
                 patch.object(m.webbrowser,'open_new_tab',return_value=result) as browser, \
                 patch.object(m,'log') as log:
                self.assertEqual(m.open_generated_webpage(self.report),result)
                browser.assert_called_once_with(self.report.as_uri())
                startfile.assert_not_called()
                if not result: self.assertIn('请手动打开',log.call_args.args[0])

    def test_default_browser_exception_is_only_logged(self):
        for error in (OSError('no association'),m.webbrowser.Error('no browser')):
            with self.subTest(error=error), patch.object(m.sys,'platform','linux'), \
                 patch.object(m.webbrowser,'open_new_tab',side_effect=error), patch.object(m,'log') as log:
                self.assertFalse(m.open_generated_webpage(self.report))
                self.assertIn('请手动打开',log.call_args.args[0])


class MonthProgressTests(unittest.TestCase):
    def test_completion_separates_metrics_and_month_lengths(self):
        panel=records(date(2024,2,1),date(2024,2,29),lambda d:10)
        lock=[dict(r,metric='交车锁单',value=20 if r['date'].day>7 else 0) for r in panel]
        output=m.month_progress_analysis(panel+lock)
        deposit=next(r for r in output if r['metric']=='大定' and r['checkpoint']==7)
        locked=next(r for r in output if r['metric']=='交车锁单' and r['checkpoint']==7)
        self.assertAlmostEqual(deposit['share'],7/29)
        self.assertAlmostEqual(deposit['pace'],1)
        self.assertEqual(locked['share'],0)
        self.assertEqual(locked['pace'],0)
        self.assertEqual({r['checkpoint'] for r in output},{7,14,21,29})

    def test_incomplete_negative_zero_and_duplicate_are_not_progress_factors(self):
        base=records(date(2025,1,1),date(2025,1,31))
        cases=[(base[:-1],'月份不完整'),([dict(r,value=-1 if r['date'].day==3 else 100) for r in base],'月份含负值'),
               ([dict(r,value=0) for r in base],'整月为零'),(base+[base[0]],'同日期重复，需核对')]
        for panel,status in cases:
            with self.subTest(status=status):
                rows=m.month_progress_analysis(panel)
                self.assertTrue(all(r['share'] is None and r['pace'] is None for r in rows))
                self.assertEqual({r['status'] for r in rows},{status})


if __name__=='__main__': unittest.main()
