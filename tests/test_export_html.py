"""Offline export safety and metric separation regression tests."""
import importlib.util
import json
import re
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('web_export_test',Path(__file__).resolve().parents[1] / 'export_html.py')
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)


def data():
    return dict(meta={'title':'测试','date_start':date(2021,1,1)},metrics=[],grouping={},
                series=[],results={'weekly':[]},rules=[],forecast={'profiles':[],'backtests':[]})


def templates(folder):
    p=Path(folder)
    (p/'patterns.html').write_text('<!doctype html><html><style>__PATTERNS_CSS__</style><script id="patterns-data" type="application/json">__PATTERNS_DATA__</script><script>__PATTERNS_JS__</script></html>',encoding='utf-8')
    (p/'patterns.css').write_text('body{color:#123}',encoding='utf-8')
    (p/'patterns.js').write_text('window.testData=window.PATTERNS_DATA;',encoding='utf-8')
    return p


class HtmlExportTests(unittest.TestCase):
    def test_web_payload_keeps_full_excel_evidence_and_metadata(self):
        results={name:[] for name in ['weekly','monthly','annual','holidays','lifecycle','period_comparisons',
                                      'period_summary','lock_lags','coverage','launch_periods','launch_pacing']}
        results['model_classes']=[dict(model='车型A',brand='品牌A',segment='产品A',energy='纯电',stages='平销',metrics='小订数量、留存大定')]
        base=dict(model='车型A',stage='平销',cycle='批次A',source='来源A',start=date(2025,1,1),end=date(2025,1,31),
                  previous_start=date(2024,12,1),previous_end=date(2024,12,31),current=310,previous=300,
                  current_days=31,current_observed=31,previous_days=31,previous_observed=31,status='有效',
                  ratio=310/300,daily_ratio=1.0,current_negative_days=0,previous_negative_days=0)
        results['period_comparisons']=[dict(base,metric='小订数量',kind='月',role='小订'),
                                       dict(base,metric='留存大定',kind='月',role='大定'),
                                       dict(base,metric='交车锁单',kind='月',role='锁单')]
        results['coverage']=[dict(metric='小订数量',stage='平销',start=date(2025,1,1),end=date(2025,1,31))]
        panel=[dict(model='车型A',metric='小订数量',stage='小订阶段',cycle='批次A',source='来源A',date=date(2025,1,1),value=10,life=1),
               dict(model='车型A',metric='留存大定',stage='平销',cycle='批次A',source='来源A',date=date(2025,1,1),value=10,life=None),
               dict(model='车型A',metric='交车锁单',stage='平销',cycle='批次A',source='来源A',date=date(2025,1,1),value=10,life=None)]
        result=e.build_web_data(dict(results=results,source='input.xlsx',sha256='abc',sample=True,audit={'负值':2},
                                     source_sheets=['逐日表'],source_mode='字段级来源'),panel)
        self.assertIn('小订数量',result['meta']['available_metrics'])
        self.assertEqual({row['metric'] for row in result['series']}, {'小订数量','留存大定','交车锁单'})
        self.assertEqual({m['label'] for m in result['metrics']}, {'小订','留存大定','锁单'})
        self.assertIn('小订数量',{row['metric'] for row in result['results']['period_comparisons']})
        self.assertEqual(result['meta']['audit'],{'负值':2})
        self.assertEqual(result['meta']['source_sheets'],['逐日表'])
        self.assertTrue(result['meta']['sample'])
        self.assertGreater(len(result['monthly_profiles']),0)
        self.assertIn('findings',result)
        self.assertIn('period_coverage',result['results'])
        self.assertNotIn('excel_name',result['meta'])

    def test_data_script_cannot_be_closed_by_source_labels(self):
        payload=data()
        attack='</script><script>throw Error("bad")</script>&__PATTERNS_JS__'
        payload['meta']['title']=attack
        payload['series']=[dict(model=attack,value=-1,metric='留存大定')]
        with tempfile.TemporaryDirectory() as tmp:
            html=e.render_html(payload,templates(tmp))
        embedded=re.search(r'type="application/json">(.*?)</script>',html,re.S)[1]
        self.assertNotIn('<',embedded)
        recovered=json.loads(embedded)
        self.assertEqual(recovered['meta']['title'],attack)
        self.assertEqual(recovered['series'][0]['value'],-1)
        self.assertEqual(recovered['meta']['date_start'],'2021-01-01')
        self.assertEqual(html.count('<script>'),1)

    def test_compaction_is_lossless_for_null_zero_and_repeated_strings(self):
        rows=[dict(model='车型A',value=0 if i%2 else None,date='2024-01-01',metric='留存大定',extra=[1,2]) for i in range(60)]
        packed=e.pack_records(rows)
        self.assertEqual(packed['$table'],1)
        rebuilt=[]
        for row in packed['rows']:
            out={}
            for i,key in enumerate(packed['columns']):
                labels=packed['dictionaries'].get(str(i)); value=row[i]
                out[key]=labels[value] if labels is not None and value is not None else value
            rebuilt.append(out)
        self.assertEqual(rebuilt,rows)
        self.assertLess(len(json.dumps(packed)),len(json.dumps(rows)))
        self.assertEqual(rows[0]['model'],'车型A')

    def test_packed_full_payload_roundtrips_months_findings_and_results(self):
        payload=data()
        payload['findings']=[dict(metric='留存大定',pattern='月度变化',typical=1.23456789,cross_year_candidate=False,index=i) for i in range(40)]
        payload['monthly_profiles']=[dict(category='全部车型',metric='小订数量',stage='平销',month=i,
                                          daily=0 if i == 1 else None,yearly='2025：100.0%') for i in range(1,50)]
        payload['results']={'period_coverage':[dict(metric='小订数量',valid=0,total=1)],
                            'weekly':[]}
        packed=e._packed(payload)
        self.assertEqual(packed['findings']['$table'],1)
        self.assertEqual(packed['monthly_profiles']['$table'],1)
        self.assertEqual(packed['monthly_profiles']['rows'][0][packed['monthly_profiles']['columns'].index('daily')],0)
        self.assertEqual(packed['results']['period_coverage'][0]['valid'],0)
        self.assertEqual(packed['findings']['rows'][0][packed['findings']['columns'].index('typical')],1.23456789)

    def test_unknown_nonfinite_numbers_fail_before_output(self):
        payload=data();payload['series']=[dict(value=float('nan'))]
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):e.render_html(payload,templates(tmp))

    def test_holiday_daily_baselines_survive_compaction_and_json_dates(self):
        payload=data()
        payload['results']['holidays']=[dict(model='车型A',metric='留存大定',year=2025,holiday='测试节',
            daily=[dict(date=date(2025,4,10),actual=0,expected=123.456789)]) for _ in range(40)]
        with tempfile.TemporaryDirectory() as tmp:
            html=e.render_html(payload,templates(tmp))
        recovered=json.loads(re.search(r'type="application/json">(.*?)</script>',html,re.S)[1])
        table=recovered['results']['holidays']
        self.assertEqual(table['$table'],1)
        i=table['columns'].index('daily')
        self.assertEqual(table['rows'][0][i],[dict(date='2025-04-10',actual=0,expected=123.456789)])

    def test_failed_replace_preserves_old_page_and_unrelated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'report.html';target.write_text('old',encoding='utf-8')
            unrelated=Path(tmp)/'keep.txt';unrelated.write_text('keep',encoding='utf-8')
            with patch.object(e.os,'replace',side_effect=PermissionError('locked')):
                with self.assertRaisesRegex(PermissionError,'上次网页已保留'):
                    e.export_html('<html>patterns-data</html>',target)
            self.assertEqual(target.read_text(encoding='utf-8'),'old')
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()),['keep.txt','report.html'])

    def test_focus_does_not_replace_missing_net_metric_with_gross_deposits(self):
        results={name:[] for name in ['weekly','monthly','annual','holidays','lifecycle','period_comparisons','period_summary','lock_lags','coverage']}
        results['model_classes']=[dict(model='车型A',brand='品牌',segment='未知',energy='纯电',stages='平销',metrics='大定')]
        results['coverage']=[dict(metric='大定',stage='平销',start=date(2025,1,1),end=date(2025,1,1))]
        panel=[dict(model='车型A',metric='大定',date=date(2025,1,1),value=100,stage='平销')]
        result=e.build_web_data(dict(results=results),panel)
        self.assertEqual(result['series'],[])
        self.assertFalse(any(m['available'] for m in result['metrics']))
        self.assertEqual(result['results']['coverage'][0]['metric'],'大定')
        self.assertEqual(result['series'],[])
        self.assertEqual(result['meta']['date_start'],None)
        self.assertEqual(result['meta']['analysis_start'],date(2025,1,1))
        self.assertEqual(result['meta']['analysis_end'],date(2025,1,1))

if __name__=='__main__':unittest.main()
