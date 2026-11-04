/* Browser regression: build source-shaped observations through the production
   source reader, then inject only the resulting isolated fixture into the
   generated report. Never reads or changes user workbooks. */
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const project = path.resolve(__dirname, '..');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.join(project, '.test_runtime/node_modules/playwright'));
const report = path.resolve(process.argv[2] || path.join(project, 'output_file/鸿蒙智行销量规律分析.html'));
const python = require('./shared_python.cjs')(process.env.PYTHON_BINARY);
const program = String.raw`
import importlib.util, json, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('quality_fixture',Path(sys.argv[1])/'test_audit_20261101_source_quality.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
base={'D1大定':10,'D2大定':20,'D1+D2大定':30,'D1小转大':4,'D1直接大':6,
      '总大定':100,'D1口径状态':'通过','D2口径状态':'通过','D1+D2口径状态':'通过',
      'D1小转大/D1大定':.4}
cases=[('有效车型',{}),('异常车型',{'D1大定':80,'D1小转大':70,'D1直接大':70,
      'D1口径状态':'数据不足或异常','D1+D2口径状态':'数据不足或异常','D1小转大/D1大定':.875}),
      ('未结束车型',{'D1口径状态':'当日未结束','D2口径状态':'当日未结束','D1+D2口径状态':'当日未结束'}),
      ('部分有效车型',{'D1大定':0,'D1小转大':0,'D1直接大':0,'D1+D2大定':20,
      'D1口径状态':'部分字段有效','D2口径状态':'部分字段有效','D1+D2口径状态':'部分字段有效',
      'D1小转大/D1大定':None})]
combined={'early_launch':[],'curves':[],'hourly':[],'inventory':[],'notes':[]}
for model, changes in cases:
    curves={'每日直接大定占比':[.4,.7],'累计直接大定占比':[.4,.6]} if model=='有效车型' else {}
    data=fixture.read_book(early={**base,**changes},curves=curves)
    for key in ('early_launch','curves'):
        for row in data[key]:row.update(model=model,model_level=model)
        combined[key].extend(data[key])
print(json.dumps(combined,ensure_ascii=False))
`;
const insights = JSON.parse(execFileSync(python, ['-X', 'utf8', '-B', '-c', program, __dirname], {encoding:'utf8'}));
const names = ['有效车型', '异常车型', '未结束车型', '部分有效车型'];
const metrics = [{key:'留存大定', label:'留存大定', source_label:'留存大定', available:true}];
const entries = names.map(model=>({model,category:'测试分类',metrics:['留存大定'],brand:'测试品牌',segment:'SUV',energy:'纯电'}));
const fixture = {
  meta:{source_name:'源表质量隔离夹具',date_start:'2025-02-01',date_end:'2025-02-28',analysis_start:'2025-02-01',analysis_end:'2025-02-28',generated_at:'2025-03-01T09:00:00',calendar_events:[]},
  metrics,series:names.flatMap(model=>[1,2].map(day=>({model,metric:'留存大定',date:'2025-02-0'+day,stage:'首销',cycle:'质量回归',source:'测试源表',value:10,life:day}))),
  rules:[],grouping:{entries,categories:['测试分类'],reason:'隔离夹具'},
  results:{coverage:[],weekly:[],monthly:[],annual:[],holidays:[],lifecycle:[],lock_lags:[],period_comparisons:[],period_summary:[],month_progress:[],launch_periods:[],launch_pacing:[],model_classes:entries,period_coverage:[]},
  forecast:{profiles:[],backtests:[],notes:[]},source_insights:insights
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
    await page.locator('#nav-patterns').click();await page.locator('#domain-lifecycle').click();await page.locator('#pattern-structure').click();
    const stats=await tableRecords(page.locator('#patternPanels .pattern-card').first().locator('table'));
    const stat=name=>stats.find(row=>row['原始指标与特征'].endsWith(' · '+name));
    assert.equal(stat('D1占最终大定比例')['典型水平'],'5%');
    assert.equal(stat('D1占最终大定比例')['车型数'],'2');
    assert.equal(stat('D1+D2占最终大定比例')['典型水平'],'25%');
    assert.equal(stat('D1+D2占最终大定比例')['车型数'],'2');
    assert.equal(stat('D2/D1大定比')['典型水平'],'200%');
    assert.equal(stat('D2/D1大定比')['车型数'],'1');checks+=3;
    await page.getByRole('button',{name:'核对逐车型D1/D2原值和分母'}).click();
    assert.equal(await page.locator('#libraryTable').inputValue(),'sourceEarly');
    await page.locator('#modelFilter').selectOption('异常车型');
    let rows=await tableRecords(page.locator('#evidenceTableWrap table'));
    assert.equal(rows.find(row=>row['特征']==='D1大定')['原值'],'80');
    assert.equal(rows.find(row=>row['特征']==='D1小转大/D1大定')['原值'],'87.5%');
    assert.match(rows.find(row=>row['特征']==='D1小转大构成')['口径状态'],/数据不足或异常/);checks++;
    await page.locator('#modelFilter').selectOption('未结束车型');
    rows=await tableRecords(page.locator('#evidenceTableWrap table'));
    assert.equal(rows.find(row=>row['特征']==='D2大定')['原值'],'20');
    assert.match(rows.find(row=>row['特征']==='D2/D1大定比')['口径状态'],/当日未结束/);checks++;
    await page.locator('#modelFilter').selectOption('有效车型');
    await page.locator('#nav-patterns').click();await page.locator('#domain-lifecycle').click();await page.locator('#pattern-structure').click();
    for (const [name,formula,expected] of [
      ['每日直接大定占比','当日直接大定 ÷ 当日总大定','70%'],
      ['累计直接大定占比','累计直接大定 ÷ 截至D日累计总大定','60%']
    ]) {
      await page.getByLabel('研究曲线',{exact:true}).selectOption(name);
      const card=page.locator('#patternPanels .pattern-card').nth(1);
      await card.locator('summary').click();
      assert.match(await card.innerText(),new RegExp(formula));
      assert.doesNotMatch(await card.innerText(),/车型基本信息\.总直接大定/);
      const curveRows=await tableRecords(card.locator('table'));
      assert.equal(curveRows.find(row=>row['D日']==='D2')['典型水平'],expected);
      await page.getByRole('button',{name:'查看逐车型原值与分母'}).click();
      await page.locator('#libraryMetric').selectOption(name);
      const sourceRows=await tableRecords(page.locator('#evidenceTableWrap table'));
      assert.ok(sourceRows.length===2&&sourceRows.every(row=>row['分母定义'].includes(formula)));
      assert.equal(await page.evaluate(name=>window.PATTERNS_DATA.source_insights.curves.filter(row=>row.curve===name).every(row=>row.denominator===null),name),true);
      assert.ok(sourceRows.some(row=>row['原值']===expected));
      await page.locator('#nav-patterns').click();checks++;
    }
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    console.log(JSON.stringify({passed:true,checks,fixture:'production source reader → isolated report payload',requests:0,pageErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
