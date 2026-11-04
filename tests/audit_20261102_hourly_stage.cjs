/* Production reader -> isolated browser fixture. No business workbook writes. */
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const project = path.resolve(__dirname, '..');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.join(project, '.test_runtime/node_modules/playwright'));
const report = path.resolve(process.argv[2] || path.join(project, 'output_file/鸿蒙智行销量规律分析.html'));
const program = String.raw`
import importlib.util, json, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('hourly_fixture',Path(sys.argv[1])/'test_audit_20261102_hourly_stage.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
rows=fixture.read_hours(['2025-01-05','2025-01-07','2025-01-08'])
for row in rows:row.update(model='明确阶段车型',model_level='明确阶段车型')
unknown=fixture.read_hours(['2025-01-06'],metadata={'首销结束':None})
for row in unknown:row.update(model='阶段未维护车型',model_level='阶段未维护车型')
print(json.dumps(rows+unknown,ensure_ascii=False))
`;
const hourly = JSON.parse(execFileSync(require('./shared_python.cjs')(process.env.PYTHON_BINARY),
  ['-X','utf8','-B','-c',program,__dirname],{encoding:'utf8'}));
const names = ['明确阶段车型','阶段未维护车型'];
const entries = names.map(model=>({model,category:'测试分类',metrics:['交车锁单'],stages:['首销','平销'],brand:'测试品牌'}));
const fixture = {
  meta:{source_name:'分时阶段隔离夹具',date_start:'2025-01-05',date_end:'2025-01-08',generated_at:'2025-02-01T09:00:00',calendar_events:[]},
  metrics:[{key:'交车锁单',label:'锁单',source_label:'交车锁单',available:true}],
  series:names.flatMap(model=>[5,6,7,8].map(day=>({model,metric:'交车锁单',date:'2025-01-0'+day,
    stage:day<=7?'首销':'平销',cycle:'2025-01-05',source:'隔离日表',value:276,life:day-4}))),
  rules:[],grouping:{entries,categories:['测试分类'],reason:'隔离夹具'},
  results:{coverage:[],weekly:[],monthly:[],annual:[],holidays:[],lifecycle:[],lock_lags:[],period_comparisons:[],period_summary:[],month_progress:[],launch_periods:[],launch_pacing:[],model_classes:entries,period_coverage:[]},
  forecast:{profiles:[],backtests:[],notes:[]},source_insights:{hourly,early_launch:[],curves:[],inventory:[],notes:[]}
};
async function tableRecords(locator) {
  return locator.evaluate(table=>{
    const headers=[...table.querySelectorAll('thead th')].map(cell=>cell.textContent.trim());
    return [...table.querySelectorAll('tbody tr')].map(row=>Object.fromEntries([...row.cells].map((cell,i)=>[headers[i],cell.textContent.trim()])));
  });
}
(async()=>{
  const browser=await chromium.launch(process.env.BROWSER_BINARY?{executablePath:process.env.BROWSER_BINARY,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  context.on('request',request=>{if(/^https?:/i.test(request.url()))requests.push(request.url());});
  await context.addInitScript(fixture=>{
    let current;Object.defineProperty(window,'PATTERNS_DATA',{configurable:true,get:()=>current,set:()=>{current=fixture;}});
  },fixture);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  let checks=0;
  try {
    await page.goto(pathToFileURL(report).href);
    await page.locator('#nav-patterns').click();await page.locator('#domain-lifecycle').click();await page.locator('#pattern-hourly').click();
    for(const [stage,count,dates] of [['首销',2,['2025-01-05','2025-01-07']],['平销',1,['2025-01-08']]]) {
      await page.locator('#stageFilter').selectOption(stage);
      const stats=await tableRecords(page.locator('#patternPanels .pattern-card').first().locator('table'));
      assert.equal(stats.length,24);
      assert.ok(stats.every(row=>row['有效车型日']===String(count)&&row['车型数']==='1'));
      assert.equal(stats.find(row=>row['小时']==='0时')['典型份额'],'0%');checks++;
      await page.getByRole('button',{name:'查看分时原值、状态和来源'}).click();
      const evidence=await tableRecords(page.locator('#evidenceTableWrap table'));
      assert.equal(evidence.length,count*24);
      assert.deepEqual([...new Set(evidence.map(row=>row['日期']))],dates);
      assert.ok(evidence.every(row=>row['源表阶段']===stage&&row['来源']==='首销by时'));
      assert.equal(evidence.find(row=>row['小时']==='23')['小时量'],'23');checks++;
      await page.locator('#nav-patterns').click();
    }
    await page.locator('#modelFilter').selectOption('阶段未维护车型');
    for(const stage of ['首销','平销']) {
      await page.locator('#stageFilter').selectOption(stage);
      assert.match(await page.locator('#patternPanels').innerText(),/源表未提供当前口径的分时数据/);
      assert.equal(await page.locator('#patternPanels table').count(),0);checks++;
    }
    const unknown=await page.evaluate(()=>window.PATTERNS_DATA.source_insights.hourly.filter(row=>row.model==='阶段未维护车型'));
    assert.equal(unknown.length,24);
    assert.deepEqual(unknown.map(row=>row.value),Array.from({length:24},(_,i)=>i));
    assert.ok(unknown.every(row=>row.stage==='阶段未知'&&row.share===null));checks++;
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    console.log(JSON.stringify({passed:true,checks,fixture:'production hourly reader → phase-filtered research and evidence',requests:0,pageErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
