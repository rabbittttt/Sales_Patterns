/* Test the production correlation reader through the real date-filter UI. */
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const project = path.resolve(__dirname,'..');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.join(project,'.test_runtime/node_modules/playwright'));
const report = path.resolve(process.argv[2] || path.join(project,'output_file/鸿蒙智行销量规律分析.html'));
const program = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('lag_fixture',Path(sys.argv[1])/'test_audit_20261103_lag_window.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
panel=fixture.make_panel()
print(json.dumps({'panel':panel,'lags':fixture.analysis.lock_lag_analysis(panel)},ensure_ascii=False,default=str))
`;
const produced = JSON.parse(execFileSync(require('./shared_python.cjs')(process.env.PYTHON_BINARY),
  ['-X','utf8','-B','-c',program,__dirname],{encoding:'utf8'}));
const entries=[{model:'配对车型',category:'测试分类',metrics:['留存大定','交车锁单'],stages:['平销']}];
const fixture={
  meta:{source_name:'锁单配对日期隔离夹具',date_start:'2025-01-01',date_end:'2025-01-21',generated_at:'2025-02-01T09:00:00',calendar_events:[]},
  metrics:[{key:'留存大定',label:'留存大定',available:true},{key:'交车锁单',label:'锁单',available:true}],
  series:produced.panel,rules:[],grouping:{entries,categories:['测试分类'],reason:'隔离夹具'},
  results:{coverage:[],weekly:[],monthly:[],annual:[],holidays:[],lifecycle:[],lock_lags:produced.lags,period_comparisons:[],period_summary:[],month_progress:[],launch_periods:[],launch_pacing:[],model_classes:entries,period_coverage:[]},
  forecast:{profiles:[],backtests:[],notes:[]},source_insights:{hourly:[],early_launch:[],curves:[],inventory:[],notes:[]}
};
async function records(locator){
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
  try{
    await page.goto(pathToFileURL(report).href);
    await page.locator('#nav-patterns').click();await page.locator('#domain-orders').click();await page.locator('#pattern-lags').click();
    let table=await records(page.locator('#patternPanels table'));
    assert.equal(table.length,4);assert.ok(table.every(row=>row['车型数']==='1'&&row['序列记录数']==='1'));checks++;
    for(const end of ['2025-01-18','2025-01-19','2025-01-20']){
      await page.locator('#dateEnd').fill(end);await page.locator('#dateEnd').dispatchEvent('change');
      table=await records(page.locator('#patternPanels table'));
      assert.ok(table.every(row=>row['车型数']==='0'&&row['水平相关中位数']==='—'));
      assert.match(await page.locator('#patternPanels').innerText(),/日期窗是否覆盖整段配对序列/);checks++;
    }
    await page.getByRole('button',{name:'核对本专题证据',exact:true}).click();
    assert.equal(await page.locator('#libraryTable').inputValue(),'lags');
    assert.match(await page.locator('#evidenceMeta').innerText(),/0 条/);
    assert.equal(await page.locator('#exportCsv').isDisabled(),true);checks++;
    await page.locator('#dateEnd').fill('2025-01-21');await page.locator('#dateEnd').dispatchEvent('change');
    const evidence=await records(page.locator('#evidenceTableWrap table'));
    assert.equal(evidence.length,4);
    assert.ok(evidence.every(row=>row['开始']==='2025-01-01'&&row['结束']==='2025-01-21'&&row['共同日期数']==='18'));
    assert.equal(await page.locator('#exportCsv').isDisabled(),false);checks++;
    await page.locator('#nav-patterns').click();
    table=await records(page.locator('#patternPanels table'));
    assert.ok(table.every(row=>row['车型数']==='1'));checks++;
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    console.log(JSON.stringify({passed:true,checks,fixture:'production lock_lag_analysis → full evidence date window',requests:0,pageErrors:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
