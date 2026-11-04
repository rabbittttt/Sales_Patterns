/* Optional development audit. Production HTML needs no Node/browser packages.
   PLAYWRIGHT_MODULE and BROWSER_BINARY may point to local installed dependencies. */
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const project = path.resolve(__dirname, "..");
const reportPath = path.resolve(process.argv[2] || path.join(project, "output_file/鸿蒙智行销量规律分析.html"));
const screenshotDir = process.env.UI_AUDIT_SCREENSHOTS;
const completed = [];
async function check(name, fn) {
  try { await fn(); completed.push(name); }
  catch (error) { error.message = name + ": " + error.message; throw error; }
}
async function until(fn) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); }
  assert.ok(await fn(), "Expected state was not reached");
}
async function textMatches(page, selector, regex) {
  await until(async () => regex.test(await page.locator(selector).innerText()));
}
function parseCsv(text) {
  const records = []; let row = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ',') { row.push(cell); cell = ""; }
    else if (!quoted && (c === '\n' || c === '\r')) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); records.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  return records;
}
async function choosePattern(page,key) {
  const domains={months:"calendar",week:"calendar",holiday:"calendar",cycles:"calendar",launch:"lifecycle",structure:"lifecycle",hourly:"lifecycle",lags:"orders"};
  const tab=page.locator("#pattern-"+key);
  if(!await tab.isVisible())await page.locator('[data-domain="'+domains[key]+'"]').click();
  await tab.click();
}
async function ensureFiltersOpen(page) {
  const toggle = page.locator("#toggleFilters");
  if (!(await toggle.count()) || !(await toggle.isVisible())) return;
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}
async function capture(page, filename) {
  if (!screenshotDir) return;
  await fs.mkdir(screenshotDir, {recursive: true});
  await page.screenshot({path: path.join(screenshotDir, filename), animations: "disabled"});
}
(async () => {
  const browser = await chromium.launch(process.env.BROWSER_BINARY ? {executablePath: process.env.BROWSER_BINARY, headless: true} : {channel: "chrome", headless: true});
  const errors = [], requests = [];
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
  context.on("page", p => { p.on("pageerror", e => errors.push(e.message)); p.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); }); });
  const page = await context.newPage(), url = pathToFileURL(reportPath).href;
  const reset = async () => { await page.goto(url); await ensureFiltersOpen(page); await page.locator("#resetFilters").click(); };
  try {
    await page.goto(url);
    await capture(page, "sales-ui-after-desktop.png");
    await check("离线SVG标签页图标可解码", async () => {
      const icon = await page.locator('link[rel="icon"]').getAttribute("href");
      assert.ok(icon.startsWith("data:image/svg+xml,"));
      assert.ok(await page.evaluate(href => new Promise(resolve => {
        const img=new Image();img.onload=()=>resolve(img.naturalWidth>0);img.onerror=()=>resolve(false);img.src=href;
      }),icon));
    });
    await check("默认阶段直接进入上市后销量节奏并保持路由范围", async () => {
      await reset();assert.equal(await page.locator("#stageFilter").inputValue(),"平销");
      const fullDates=[await page.locator("#dateStart").inputValue(),await page.locator("#dateEnd").inputValue()];
      await page.locator("#nav-patterns").click();await choosePattern(page,"launch");
      const stageOptions=await page.locator("#stageFilter option").allTextContents(),entryStage=stageOptions.includes("首销及平销")?"首销及平销":stageOptions.includes("首销")?"首销":"平销";
      assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      assert.equal(await page.evaluate(()=>new URLSearchParams(location.hash.slice(1)).get("stage")),entryStage);
      assert.deepEqual([await page.locator("#dateStart").inputValue(),await page.locator("#dateEnd").inputValue()],fullDates);
      const expected=await page.evaluate(()=>{const from=document.getElementById("dateStart").value,to=document.getElementById("dateEnd").value;return (window.PATTERNS_DATA.results.launch_pacing||[]).filter(r=>r.metric==="留存大定"&&r.grain==="周"&&r.observed_start>=from&&r.observed_end<=to);});
      assert.ok(expected.length>0);assert.match(await page.locator("#patternPanels").innerText(),/上市第N周日均销量|上市第N月日均销量/);assert.match(await page.locator("#patternPanels").innerText(),/相邻上市期间日均比/);assert.equal(await page.locator("#patternPanels .pattern-card").last().locator("tbody tr").count(),expected.length);
      await capture(page,"sales-launch-default-entry-fixed.png");
      await page.locator("#stageFilter").selectOption("首销");
      const launchRule=await page.evaluate(()=>window.PATTERNS_DATA.rules.find(r=>r.category==="全部车型"&&r.metric==="留存大定"&&r.stage==="首销"&&r.pattern==="上市第2周/第1周"));
      if(launchRule&&launchRule.typical!==null){
        const indexCard=page.locator("#patternPanels .pattern-card").filter({has:page.getByRole("heading",{name:"上市第N周首期相对指数",exact:true})});
        const indexRow=await indexCard.locator("tbody tr").evaluateAll(rs=>rs.map(r=>[...r.cells].map(c=>c.textContent.trim())).find(r=>r[0]==="第2周"));
        const percent=new Intl.NumberFormat("zh-CN",{style:"percent",maximumFractionDigits:1});
        assert.deepEqual(indexRow.slice(1,4),[launchRule.p25,launchRule.typical,launchRule.p75].map(x=>percent.format(x)));
      }
      await page.locator("#stageFilter").selectOption(entryStage);
      await page.locator('[data-metric="交车锁单"]').click();assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      const lockCount=await page.evaluate(()=>window.PATTERNS_DATA.results.launch_pacing.filter(r=>r.metric==="交车锁单"&&r.grain==="周"&&r.status==="有效"&&r.daily_ratio!==null).length);
      assert.ok(lockCount>0);assert.equal(Number(await page.locator("#patternKpis .kpi-card:nth-child(2) .kpi-value").innerText()),lockCount);
      await page.locator("#resetFilters").click();assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      await choosePattern(page,"holiday");assert.equal(await page.locator("#stageFilter").inputValue(),"平销");assert.equal(await page.evaluate(()=>new URLSearchParams(location.hash.slice(1)).get("stage")),"平销");
      await choosePattern(page,"launch");assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      await page.locator("#stageFilter").selectOption("平销");assert.match(await page.locator("#patternPanels").innerText(),/切换到首销及平销/);await page.getByRole("button",{name:"切换到首销及平销"}).click();assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      const category=await page.evaluate(model=>window.PATTERNS_DATA.grouping.entries.find(r=>r.model===model).category,expected[0].model);
      await page.locator("#categoryFilter").selectOption(category);await page.locator("#modelFilter").selectOption(expected[0].model);
      const selectedStage=await page.locator("#stageFilter").inputValue();
      const narrowDate=expected[0].observed_start||expected[0].start;await page.locator("#dateStart").fill(narrowDate);await page.locator("#dateStart").dispatchEvent("change");await page.locator("#dateEnd").fill(narrowDate);await page.locator("#dateEnd").dispatchEvent("change");
      await choosePattern(page,"cycles");await choosePattern(page,"launch");
      assert.equal(await page.locator("#stageFilter").inputValue(),selectedStage);assert.equal(await page.locator("#dateStart").inputValue(),narrowDate);assert.equal(await page.locator("#dateEnd").inputValue(),narrowDate);
      assert.match(await page.locator("#patternPanels").innerText(),/当前日期范围排除了上市后期间或相邻比较记录|当前日期范围没有完整可比期间/);
      await page.getByRole("button",{name:"恢复当前口径日期"}).click();
      assert.deepEqual([await page.locator("#dateStart").inputValue(),await page.locator("#dateEnd").inputValue()],fullDates);
      assert.equal(await page.locator("#categoryFilter").inputValue(),category);assert.equal(await page.locator("#modelFilter").inputValue(),expected[0].model);
      assert.equal(await page.locator("#patternPanels .pattern-card").last().locator("tbody tr").count(),expected.filter(r=>r.model===expected[0].model).length);
      const oldRoute=new URLSearchParams({page:"patterns",pattern:"launch",stage:"平销",metric:"留存大定",category:"__ALL__",model:"__ALL__"});await page.goto(url+"#"+oldRoute.toString());
      assert.equal(await page.locator("#stageFilter").inputValue(),"平销");await page.getByRole("button",{name:"切换到首销及平销"}).click();await page.reload();
      assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      await page.locator("#nav-overview").click();assert.ok(!(await page.locator("#stageFilter option").allTextContents()).includes("首销及平销"));await page.locator('[data-metric="交车锁单"]').click();assert.equal(await page.locator("#stageFilter").inputValue(),"平销");
      await page.goBack();assert.equal(await page.locator("#pattern-launch").getAttribute("aria-selected"),"true");assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
      await reset();
    });
    await check("从上市后专题返回首页再进入月份入口保留首销阶段", async () => {
      await reset();
      await page.locator("#nav-patterns").click(); await choosePattern(page, "launch");
      await page.locator("#stageFilter").selectOption("首销");
      await page.locator("#nav-overview").click();
      await page.locator("#stageFilter").selectOption("首销");
      const monthEntry = page.getByRole("button", {name: /月份和月内进度/});
      assert.equal(await monthEntry.count(), 1);
      await monthEntry.click();
      assert.equal(await page.locator("#pageTitle").innerText(), "规律研究");
      assert.equal(await page.locator("#pattern-months").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#stageFilter").inputValue(), "首销");
    });
    await check("上市后节奏按口径、车型和完整日期窗口筛选", async () => {
      for(const metric of ["留存大定","交车锁单"]){
        await reset();await page.locator('[data-metric="'+metric+'"]').click();
        await page.locator("#stageFilter").selectOption("首销");
        await page.locator("#nav-patterns").click();await choosePattern(page,"launch");
        const expected=await page.evaluate(metric=>window.PATTERNS_DATA.results.launch_pacing.filter(r=>r.metric===metric&&r.grain==="周"&&r.status==="有效"&&r.daily_ratio!==null),metric);
        assert.ok(expected.length>0);
        if(metric==="留存大定")await capture(page,"sales-launch-desktop.png");
        const first=expected[0];await page.locator("#modelFilter").selectOption(first.model);
        const stageOptions=await page.locator("#stageFilter option").allTextContents(),entryStage=stageOptions.includes("首销及平销")?"首销及平销":stageOptions.includes("首销")?"首销":"平销";
        assert.equal(await page.locator("#stageFilter").inputValue(),entryStage);
        const text=await page.locator("#patternPanels").textContent();
        assert.ok(text.includes(first.model));
        assert.ok(text.includes(new Intl.NumberFormat("zh-CN",{style:"percent",maximumFractionDigits:1}).format(first.ratio)));
        await page.reload();assert.equal(await page.locator("#pattern-launch").getAttribute("aria-selected"),"true");
        await page.locator("#dateStart").fill(first.start);await page.locator("#dateStart").dispatchEvent("change");
        const evidenceRows=await page.locator("#patternPanels .pattern-card").last().locator("tbody tr").evaluateAll(rs=>rs.map(r=>[...r.cells].map(c=>c.textContent.trim())));
        assert.ok(!evidenceRows.some(r=>r[0]===first.model&&r[1]==="第"+first.previous_period_no+"周"&&r[2]==="第"+first.period_no+"周"));
      }
      await reset();
    });
    await check("上市后周月、跨阶段、缺日与换源保持口径（独立夹具）", async () => {
      const fixture=await context.newPage();
      await fixture.addInitScript(()=>{
        let value;
        Object.defineProperty(window,"PATTERNS_DATA",{configurable:true,get:()=>value,set:incoming=>{
          const metrics=[{key:"留存大定",label:"留存大定",source_label:"留存大定",available:true},{key:"交车锁单",label:"锁单",source_label:"交车锁单",available:true}];
          const models=["UI上市A","UI上市B"],dates=Array.from({length:69},(_,i)=>new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10));
          const series=metrics.flatMap(metric=>models.flatMap(model=>dates.map((date,i)=>({
            model,metric:metric.key,date,stage:date<=(model==="UI上市A"?"2025-01-10":"2025-01-14")?"首销":"平销",cycle:"2025-01-01",life:i+1,
            source:model==="UI上市A"?(i<21?"来源A":"来源B"):"来源C",value:(model==="UI上市A"?Math.min(4,Math.floor(i/7)+1)*10:10)*(metric.key==="交车锁单"?2:1)
          }))));
          const entries=models.map((model,i)=>({model,category:"UI分类"+i,metrics:metrics.map(m=>m.key)}));
          const periods=[];
          function period(model,metric,grain,no,start,end){
            const rows=series.filter(r=>r.model===model&&r.metric===metric&&r.date>=start&&r.date<=end),sources=[...new Set(rows.map(r=>r.source))];
            const days=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1,current=rows.reduce((a,r)=>a+r.value,0),stages=[...new Set(rows.map(r=>r.stage))];
            return {model,metric,grain,period_no:no,cycle:"2025-01-01",start,end,observed_start:rows[0].date,observed_end:rows.at(-1).date,
              current,observed:rows.length,expected_days:days,daily_avg:rows.length===days?current/days:null,source:sources.join("；"),stage:stages.length>1?"跨阶段":stages[0],
              status:sources.length>1?"来源切换不可比":rows.length===days?"有效":"本期缺失或不完整"};
          }
          for(const metric of metrics){
            for(const model of models)for(let n=1;n<=4;n++)periods.push(period(model,metric.key,"周",n,dates[(n-1)*7],dates[n*7-1]));
            [["2025-01-01","2025-01-31"],["2025-02-01","2025-02-28"],["2025-03-01","2025-03-31"]].forEach(([start,end],i)=>periods.push(period("UI上市B",metric.key,"月",i+1,start,end)));
          }
          const comparisons=[];
          for(const current of periods){
            const previous=periods.find(p=>p.model===current.model&&p.metric===current.metric&&p.grain===current.grain&&p.period_no===current.period_no-1);if(!previous)continue;
            const status=previous.source!==current.source?"来源切换不可比":previous.status!=="有效"?"前期缺失或不完整":current.status;
            comparisons.push({...current,stage:previous.stage===current.stage?current.stage:"跨阶段",previous_stage:previous.stage,current_stage:current.stage,
              previous_period_no:previous.period_no,pattern:"上市第"+current.period_no+current.grain+"/第"+previous.period_no+current.grain,
              previous_start:previous.start,previous_end:previous.end,observed_start:previous.observed_start,observed_end:current.observed_end,
              previous:previous.current,previous_observed:previous.observed,current_observed:current.observed,previous_days:previous.expected_days,current_days:current.expected_days,
              previous_source:previous.source,current_source:current.source,ratio:status==="有效"?current.current/previous.current:null,
              daily_ratio:status==="有效"?current.daily_avg/previous.daily_avg:null,status});
          }
          const results=Object.fromEntries(Object.keys(incoming.results).map(key=>[key,[]]));Object.assign(results,{launch_periods:periods,launch_pacing:comparisons,model_classes:entries});
          value={...incoming,meta:{...incoming.meta,source_name:"上市后独立UI夹具",date_start:dates[0],date_end:dates.at(-1),calendar_events:[]},series,metrics,
            grouping:{entries,categories:entries.map(r=>r.category),reason:"测试夹具"},results,rules:[],forecast:{profiles:[],backtests:[],notes:[]}};
        }});
      });
      const card=title=>fixture.locator("#patternPanels .pattern-card").filter({has:fixture.getByRole("heading",{name:title,exact:true,includeHidden:true})});
      const cells=async section=>section.locator("tbody tr").evaluateAll(rs=>rs.map(r=>[...r.cells].map(c=>c.textContent.trim())));
      const periodEvidence=async()=>card("上市期间逐车型证据").locator("table").evaluate(table=>{const headers=[...table.querySelectorAll("thead th")].map(c=>c.textContent.trim());return [...table.querySelectorAll("tbody tr")].map(r=>Object.fromEntries([...r.cells].map((c,i)=>[headers[i],c.textContent.trim()])));});
      await fixture.goto(url);await fixture.locator("#nav-patterns").click();await choosePattern(fixture,"launch");
      assert.equal(await fixture.locator("#stageFilter").inputValue(),"首销及平销");
      let detail=await cells(card("逐车型相邻期间证据"));assert.equal(detail.length,6);
      const switched=detail.find(r=>r[0]==="UI上市A"&&r[2]==="第4周");assert.deepEqual(switched.slice(7,10),["—","—","来源切换不可比"]);
      const index=await cells(card("上市第N周首期相对指数"));assert.deepEqual(index.find(r=>r[0]==="第4周").slice(4),["1","1"]);
      assert.ok((await periodEvidence()).some(r=>r["阶段"]==="跨阶段"));
      await capture(fixture,"post-launch-cross-stage-fixture.png");
      await fixture.locator("#stageFilter").selectOption("平销");detail=await cells(card("逐车型相邻期间证据"));assert.equal(detail.length,2);assert.ok(detail.every(r=>r[3]==="平销"&&r[4]==="平销"));
      await fixture.locator("#categoryFilter").selectOption("UI分类1");await fixture.locator("#modelFilter").selectOption("UI上市B");await fixture.locator("#stageFilter").selectOption("首销及平销");await fixture.locator("#launchGrain").selectOption("月");
      let monthly=await periodEvidence();assert.equal(monthly.length,3);assert.equal(monthly[2]["上市期间"],"第3月");assert.deepEqual([monthly[2]["观测/应有天数"],monthly[2]["日均"],monthly[2]["状态"]],["10/31","—","本期缺失或不完整"]);
      detail=await cells(card("逐车型相邻期间证据"));assert.deepEqual(detail[0].slice(7,9),["90.3%","100%"]);assert.deepEqual(detail[1].slice(7,9),["—","—"]);
      await capture(fixture,"post-launch-month-partial-fixture.png");
      await fixture.reload();assert.equal(await fixture.locator("#launchGrain").inputValue(),"月");assert.equal(await fixture.locator("#stageFilter").inputValue(),"首销及平销");
      await fixture.locator("#dateEnd").fill("2025-03-05");await fixture.locator("#dateEnd").dispatchEvent("change");monthly=await periodEvidence();assert.equal(monthly.length,2);
      await fixture.locator('[data-metric="交车锁单"]').click();detail=await cells(card("逐车型相邻期间证据"));assert.equal(detail[0][5],"620 / 560");assert.deepEqual(detail[0].slice(7,9),["90.3%","100%"]);
      await fixture.locator("#nav-overview").click();assert.ok(!(await fixture.locator("#stageFilter option").allTextContents()).includes("首销及平销"));
      await fixture.locator("#nav-patterns").click();assert.equal(await fixture.locator("#stageFilter").inputValue(),"首销及平销");
      await fixture.close();await reset();
    });
    await check("空白试算不当作零；零值可正常计算", async () => {
      await page.locator("#nav-forecast").click();
      await textMatches(page, "#trialResult", /—/);
      await page.locator("#trialBase").fill("0");
      await textMatches(page, "#trialResult", /\n0 辆/);
      await page.locator("#trialBase").fill("");
      await textMatches(page, "#trialResult", /—/);
    });
    await check("整数天数、负数及超大数的输入反馈", async () => {
      await page.locator("#trialBase").fill("100"); await page.locator("#trialDays").fill("2.5");
      await textMatches(page, "#trialError", /整数/);
      assert.equal(await page.locator("#trialDays").getAttribute("aria-invalid"), "true");
      await page.locator("#trialDays").fill("30"); await page.locator("#trialFactor").fill("-1");
      await textMatches(page, "#trialError", /倍率/);
      await page.locator("#trialFactor").fill("1.2"); await textMatches(page, "#trialResult", /3,600 辆/);
      await page.locator("#trialBase").fill("1e308"); await textMatches(page, "#trialError", /数值过大/);
      await page.locator("#trialBase").fill("100");
      await page.locator('[name="trialMode"][value="period"]').check();
      await textMatches(page, "#trialResult", /120 辆/);
      assert.equal(await page.locator("#trialDaysField").isVisible(), false);
      await page.locator('[name="trialMode"][value="daily"]').check();
    });
    await check("错误日期不会静默改动另一端或改变当前结果", async () => {
      await page.locator("#nav-overview").click();
      const notice = await page.locator("#rangeNotice").innerText(), end = await page.locator("#dateEnd").inputValue();
      await page.locator("#dateStart").fill(""); await page.locator("#dateStart").dispatchEvent("change");
      await textMatches(page, "#dateError", /上次有效范围/);
      assert.equal(await page.locator("#dateEnd").inputValue(), end);
      assert.equal(await page.locator("#rangeNotice").innerText(), notice);
      await page.locator("#resetFilters").click(); assert.equal(await page.locator("#dateError").isVisible(), false);
      await page.locator("#dateStart").fill("2010-01-01"); await page.locator("#dateStart").dispatchEvent("change");
      await textMatches(page, "#dateError", /覆盖范围/);
      await page.locator("#resetFilters").click();
    });
    await check("分类、车型和回测列表共用同一范围", async () => {
      await page.locator("#modelFilter").selectOption({index: 1});
      const model = await page.locator("#modelFilter").inputValue();
      await page.locator("#nav-forecast").click();
      assert.equal(await page.locator("#forecastModel option").count(), 1);
      assert.equal(await page.locator("#forecastModel").inputValue(), model);
      await page.locator("#resetFilters").click();
      await page.locator("#categoryFilter").selectOption({index: 1});
      const valid = await page.evaluate(() => {
        const category = document.getElementById("categoryFilter").value;
        const map = new Map(window.PATTERNS_DATA.grouping.entries.map(x => [x.model, x.category]));
        return [...document.getElementById("forecastModel").options].every(o => !o.value || map.get(o.value) === category);
      });
      assert.equal(valid, true); await page.locator("#resetFilters").click();
    });
    await check("有效回测图表与WAPE评分（测试夹具，与业务数据隔离）", async () => {
      const fixture = await context.newPage();
      await fixture.addInitScript(() => {
        let value;
        Object.defineProperty(window,"PATTERNS_DATA",{configurable:true,get:()=>value,set:incoming=>{
          const model="UI回归测试车型",source="UI回归测试来源（非业务数据）",metric="留存大定",stage="平销",cycle="UI回归夹具";
          const base={model,source,metric,stage,cycle};
          const series=Array.from({length:91},(_,i)=>({...base,date:new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10),value:100,life:null}));
          const entry={model,category:"UI测试分类",metrics:[metric],brand:"UI测试品牌",segment:"测试",energy:"测试"};
          const profile={...base,grain:"日",cutoff:"2024-03-31",target_start:"2024-04-01",target_end:"2024-04-01",baseline:100,estimate:120,status:"ok",train_samples:60,method:"仅用于UI回归"};
          const backtests=[{...base,grain:"日",origin:"2024-01-29",target_start:"2024-01-30",target_end:"2024-01-30",actual:100,predicted:120,baseline:90,status:"ok",train_samples:20},{...base,grain:"日",origin:"2024-01-30",target_start:"2024-01-31",target_end:"2024-01-31",actual:150,predicted:130,baseline:140,status:"ok",train_samples:21}];
          value={...incoming,meta:{...incoming.meta,source_name:"UI回归测试夹具",date_start:"2024-01-01",date_end:"2024-03-31"},series,metrics:[{key:metric,label:"留存大定",source_label:"留存大定",available:true},{key:"交车锁单",label:"锁单",source_label:"交车锁单",available:false}],grouping:{entries:[entry],categories:[entry.category],reason:"UI测试夹具"},rules:[],results:Object.fromEntries(Object.keys(incoming.results).map(k=>[k,k==="model_classes"?[entry]:[]])),forecast:{profiles:[profile],backtests,notes:[]}};
        }});
      });
      await fixture.goto(url);await fixture.locator("#nav-forecast").click();await fixture.locator("#forecastGrain").selectOption("日");
      assert.equal(await fixture.locator("#backtestChart svg").count(),1);
      assert.equal(await fixture.evaluate(()=>new URLSearchParams(location.hash.slice(1)).get("profileKey")),await fixture.locator("#forecastProfile").inputValue());
      assert.equal(await fixture.locator("#backtestTableWrap tbody tr").count(),2);
      assert.ok((await fixture.locator("#forecastKpis").innerText()).includes("16% / 8%"));
      await fixture.locator("#panel-forecast .profile-detail summary").click();assert.ok((await fixture.locator("#forecastSelection").innerText()).includes("非业务数据"));
      await fixture.setViewportSize({width:390,height:844});assert.ok(await fixture.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.equal(await fixture.locator("#backtestChart").getAttribute("tabindex"),"0");
       await fixture.locator("#nav-patterns").click();await choosePattern(fixture,"launch");
       assert.equal(await fixture.locator("#stageFilter").inputValue(),"平销");assert.match(await fixture.locator("#patternPanels").innerText(),/没有上市后期间记录|请检查首销日期|重置/);
      await fixture.close();await reset();
    });
    await check("节假日范围汇总按日合计实际与基准并联动左侧筛选（测试夹具）", async () => {
      await page.locator("#nav-patterns").click();await choosePattern(page,"holiday");await capture(page,"sales-holiday-actual.png");
      const fixture = await context.newPage();
      const fixtureErrors=[];fixture.on("pageerror",e=>fixtureErrors.push(e.message));
      await fixture.addInitScript(() => {
        let value;
        Object.defineProperty(window,"PATTERNS_DATA",{configurable:true,get:()=>value,set:incoming=>{
           const source="UI节假日来源（非业务数据）";
           const metricDefs=[{key:"留存大定",label:"留存大定",source_label:"留存大定",available:true},{key:"交车锁单",label:"锁单",source_label:"交车锁单",available:true}];
           const models=[{model:"UI车型A",category:"UI分类A",values:{"留存大定":[200,100],"交车锁单":[100,100]}},{model:"UI车型B",category:"UI分类B",values:{"留存大定":[900,900],"交车锁单":[600,900]}}];
           const events=[
             {year:2024,holiday:"UI节日",start:"2024-01-08",end:"2024-01-10"},
             {year:2024,holiday:"UI零值节日",start:"2024-01-25",end:"2024-01-27"},
             {year:2024,holiday:"UI旧网页节日",start:"2024-02-10",end:"2024-02-12"},
             {year:2024,holiday:"UI冲突节日",start:"2024-02-25",end:"2024-02-27"},
             {year:2024,holiday:"UI春节与调休假期",start:"2024-03-01",end:"2024-03-03"},
             {year:2024,holiday:"UI劳动节假期",start:"2024-03-08",end:"2024-03-10"},
             {year:2024,holiday:"UI中秋国庆合并假期",start:"2024-03-15",end:"2024-03-17"},
             {year:2024,holiday:"UI跨年连续休假",start:"2024-03-20",end:"2024-03-22"}
           ];
           const dates=Array.from({length:90},(_,i)=>new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10));
           const series=metricDefs.flatMap(def=>models.flatMap(m=>["平销","首销"].flatMap(stage=>dates.map(date=>({model:m.model,metric:def.key,stage,cycle:"UI节日周期",source,date,value:m.values[def.key][0],life:null})))));
           const entries=models.map(m=>({model:m.model,category:m.category,metrics:metricDefs.map(x=>x.key),brand:"UI测试品牌",segment:"测试",energy:"测试"}));
           const windowDates=event=>{const first=Date.parse(event.start+"T00:00:00Z")-7*86400000,last=Date.parse(event.end+"T00:00:00Z")+7*86400000,out=[];for(let ts=first;ts<=last;ts+=86400000)out.push(new Date(ts).toISOString().slice(0,10));return out;};
           const dailyFor=(m,event,metricKey)=>windowDates(event).map(date=>({date,actual:event.holiday==="UI零值节日"&&m.model==="UI车型A"?0:m.values[metricKey][0],expected:m.values[metricKey][1]}));
           const holidayRows=metricDefs.flatMap(def=>events.flatMap(event=>models.flatMap(m=>{
             if(event.holiday==="UI零值节日"&&m.model==="UI车型B")return [];
             const base={model:m.model,metric:def.key,stage:"平销",cycle:"UI节日周期",source,year:event.year,holiday:event.holiday,before:m.values[def.key][0]/m.values[def.key][1],during:m.values[def.key][0]/m.values[def.key][1],after:m.values[def.key][0]/m.values[def.key][1],control_days:14};
             if(event.holiday==="UI旧网页节日"&&m.model==="UI车型A")return [base];
             const daily=dailyFor(m,event,def.key),row={...base,daily};
             if(event.holiday==="UI冲突节日"&&m.model==="UI车型A")return [row,{...row,daily:daily.map((x,i)=>i===0?{...x,actual:x.actual+1}:x)}];
             return [row];
           })));
          const results=Object.fromEntries(Object.keys(incoming.results).map(k=>[k,k==="holidays"?holidayRows:k==="model_classes"?entries:[]]));
           value={...incoming,meta:{...incoming.meta,source_name:"UI节假日测试夹具",date_start:dates[0],date_end:dates[dates.length-1],calendar_events:events},series,metrics:metricDefs,grouping:{entries,categories:[...new Set(entries.map(x=>x.category))],reason:"UI测试夹具"},rules:[],results,forecast:{profiles:[],backtests:[],notes:[]}};
        }});
      });
      await fixture.goto(url);await fixture.locator("#nav-patterns").click();await choosePattern(fixture,"holiday");
       let scope=fixture.locator("#patternPanels .pattern-card").first();if(!(await scope.count()))throw new Error("holiday fixture render failed: "+fixtureErrors.join(" | "));
       const scopeRows=async()=>scope.locator("tbody tr").evaluateAll(nodes=>nodes.map(tr=>[...tr.cells].map(td=>td.innerText.trim())));
       const scopeRow=async holiday=>{const row=(await scopeRows()).find(cells=>cells[0]===holiday);assert.ok(row,"missing holiday row: "+holiday);return row;};
       assert.equal(await scope.locator(".bar-row").count(),21);
       assert.equal(await scope.locator(".pattern-chart").getAttribute("tabindex"),"0");
       assert.equal(await scope.locator(".bar-label").first().innerText(),"2024年UI节日 · 节前");
       const methodDetails=scope.locator("details.profile-detail");
       assert.equal(await methodDetails.count(),1);
       assert.equal(await methodDetails.evaluate(node=>node.open),false);
       assert.equal(await scope.locator("p.card-subtitle").filter({hasText:"每日指数＝当日销量÷同星期基准"}).count(),1);
       await methodDetails.locator("summary").focus();await fixture.keyboard.press("Enter");
       assert.equal(await methodDetails.evaluate(node=>node.open),true);
       const methodText=await methodDetails.innerText();
       for(const detail of ["第8—35天","算术平均","同星期至少4个","110%","跨年的同名节日","有效车型/所选车型","不作为未来预测系数"])assert.ok(methodText.includes(detail),detail);
       for(const width of [1440,390]){
         await fixture.setViewportSize({width,height:1000});
         // The page redraws after a 150 ms resize debounce, resetting native details.
         await fixture.waitForTimeout(200);
         if(!(await methodDetails.evaluate(node=>node.open)))await methodDetails.locator("summary").click();
         await until(()=>methodDetails.evaluate(node=>node.open));
         assert.ok(await fixture.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
         if(screenshotDir)await methodDetails.screenshot({path:path.join(screenshotDir,`sales-holiday-method-${width}.png`),animations:"disabled"});
       }
       await methodDetails.locator("summary").click();await until(async()=>!(await methodDetails.evaluate(node=>node.open)));
       const modelHolidayCard=fixture.locator("#patternPanels .pattern-card").filter({hasText:"节前、节中、节后日均指数（逐车型）"}).first();
       const holidayDisclosure=modelHolidayCard.locator("xpath=ancestor::details");
       if(await holidayDisclosure.count())await holidayDisclosure.locator("summary").first().click();
       const modelHolidayChart=modelHolidayCard.locator(".pattern-chart");
       assert.equal(await modelHolidayChart.locator(".bar-row").count(),24);
       assert.equal(await modelHolidayChart.locator("svg").count(),0);
       assert.equal(await modelHolidayChart.getAttribute("tabindex"),"0");
       assert.equal(await modelHolidayChart.getAttribute("aria-label"),"横向条形图，可上下滚动查看全部内容");
       const holidayLabels=await modelHolidayChart.locator(".bar-label").allTextContents();
       const holidayValues=await modelHolidayChart.locator(".bar-value").allTextContents();
       for(const width of [1440,1920,390]){
         await fixture.setViewportSize({width,height:1000});
         await fixture.waitForTimeout(200);
         assert.ok(await fixture.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"expanded holiday evidence overflows at "+width+"px");
         assert.deepEqual(await modelHolidayChart.locator(".bar-label").allTextContents(),holidayLabels);
         assert.deepEqual(await modelHolidayChart.locator(".bar-value").allTextContents(),holidayValues);
         assert.ok(await modelHolidayChart.evaluate(node=>{
           const rows=[...node.querySelectorAll(".bar-row")];
           return node.scrollHeight>node.clientHeight&&node.scrollWidth<=node.clientWidth+1&&rows.every((row,i)=>{
             const label=row.querySelector(".bar-label"),track=row.querySelector(".bar-track"),value=row.querySelector(".bar-value");
             return label.scrollWidth<=label.clientWidth+1&&label.getBoundingClientRect().right<=track.getBoundingClientRect().left+1&&track.getBoundingClientRect().right<=value.getBoundingClientRect().left+1&&(!i||rows[i-1].getBoundingClientRect().bottom<=row.getBoundingClientRect().top+1);
           });
         }),"holiday labels must remain readable without overlap");
         await modelHolidayChart.scrollIntoViewIfNeeded();
         await capture(fixture,`sales-holiday-second-${width}.png`);
       }
       await modelHolidayChart.evaluate(node=>{node.scrollTop=0;});
       await modelHolidayChart.focus();await fixture.keyboard.press("End");
       await until(()=>modelHolidayChart.evaluate(node=>node.scrollTop>0));
       await capture(fixture,"sales-holiday-fixture.png");
      let text=await scope.innerText();
      assert.ok(text.includes("鸿蒙智行全部车型"));assert.ok(text.includes("UI节日"));assert.ok(text.includes("110%"));assert.ok(text.includes("2"));
       let row=await scopeRow("UI节日");assert.deepEqual(row.slice(3,8),["110%","110%","110%","2","2"]);
       row=await scopeRow("UI零值节日");assert.equal(row[3],"0%");assert.equal(row[6],"1");assert.match(row[8],/无历史对照 1\/2/);
       row=await scopeRow("UI冲突节日");assert.equal(row[6],"1");assert.equal(row[7],"2");assert.match(row[8],/逐日对照冲突 1\/2/);
       await ensureFiltersOpen(fixture);
       await fixture.locator("#categoryFilter").selectOption("UI分类B");await choosePattern(fixture,"holiday");
       text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("UI分类B"));assert.ok(text.includes("100%"));
       await fixture.locator("#categoryFilter").selectOption("__ALL__");await fixture.locator('[data-metric="交车锁单"]').click();await choosePattern(fixture,"holiday");
        text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("70%"));row=await scopeRow("UI节日");assert.deepEqual(row.slice(3,8),["70%","70%","70%","2","2"]);
       await fixture.locator('[data-metric="留存大定"]').click();await fixture.locator("#modelFilter").selectOption("UI车型A");await choosePattern(fixture,"holiday");
        text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("UI车型A"));assert.ok(text.includes("200%"));row=await scopeRow("UI节日");assert.deepEqual(row.slice(3,8),["200%","200%","200%","1","1"]);
      await fixture.locator("#modelFilter").selectOption("UI车型B");await choosePattern(fixture,"holiday");
       text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("UI车型B"));assert.ok(text.includes("100%"));
       await fixture.locator("#modelFilter").selectOption("__ALL__");await choosePattern(fixture,"holiday");await fixture.locator("#stageFilter").selectOption("首销");
       text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("0/2"));assert.ok(text.includes("无历史对照"));
       await fixture.getByRole("button",{name:"切换到平销阶段"}).click();assert.equal(await fixture.locator("#stageFilter").inputValue(),"平销");
       await fixture.locator("#stageFilter").selectOption("平销");await fixture.locator("#dateStart").fill("2024-01-02");await fixture.locator("#dateStart").dispatchEvent("change");await choosePattern(fixture,"holiday");
       text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(!text.includes("UI节日"));assert.ok(text.includes("UI零值节日"));
       await fixture.locator("#dateStart").fill("2024-01-01");await fixture.locator("#dateStart").dispatchEvent("change");
       text=await fixture.locator("#patternPanels .pattern-card").first().innerText();assert.ok(text.includes("UI旧网页节日"),text);assert.ok(text.includes("旧网页缺少逐日基准"),text);assert.ok(text.includes("UI冲突节日"),text);assert.ok(text.includes("逐日对照冲突"),text);
       assert.deepEqual(fixtureErrors,[]);await fixture.close();await reset();
    });
    await check("刷新和浏览器后退保留页面、规律类别与筛选", async () => {
      await page.locator("#nav-patterns").click(); await choosePattern(page,"week");
      await page.locator("#modelFilter").selectOption({index: 1});
      const model = await page.locator("#modelFilter").inputValue();
      await page.reload(); assert.equal(await page.locator("#pageTitle").innerText(), "规律研究");
      assert.equal(await page.locator('[data-pattern="week"]').getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#modelFilter").inputValue(), model);
      await page.locator("#nav-evidence").click(); await page.goBack();
      await until(async () => await page.locator("#pageTitle").innerText() === "规律研究");
      await page.locator(".brand").click(); assert.equal(await page.locator("#pageTitle").innerText(), "研究首页");
    });
    await check("键盘导航、快捷跳转和可滚动表格", async () => {
      await page.locator("#nav-overview").focus(); await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#nav-patterns").getAttribute("aria-selected"), "true");
      await choosePattern(page,"week");
      await page.locator('[data-pattern="week"]').focus(); await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator('[data-pattern="holiday"]').getAttribute("aria-selected"), "true");
      await page.locator('[data-domain="lifecycle"]').focus();await page.keyboard.press("Enter");
      assert.equal(await page.locator('[data-domain="lifecycle"]').getAttribute("aria-selected"),"true");
      await choosePattern(page,"holiday");
      await page.locator("#categoryFilter").selectOption("__ALL__");
      await page.locator("#modelFilter").selectOption("__ALL__");
      await choosePattern(page,"holiday");
      const holidayScopeText = await page.locator("#patternPanels").innerText();
      assert.ok(holidayScopeText.includes("当前筛选范围节假日指数"));
      assert.ok(holidayScopeText.includes("鸿蒙智行全部车型") || holidayScopeText.includes("范围有效事件"));
      assert.ok(holidayScopeText.includes("有效车型"));
      assert.equal(await page.locator(".topbar .main-nav .nav-item").count(), 4);
      assert.equal(await page.locator(".sidebar .main-nav").count(), 0);
      assert.equal(await page.locator(".workflow-guide").count(), 0);
      await page.locator('footer [data-go="evidence"]').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), "pageTitle");
      assert.equal(await page.locator("#evidenceTableWrap").getAttribute("tabindex"), "0");
      await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => document.activeElement.id), "mainContent");
    });
    await reset();
    await check("搜索空状态可恢复且不会导出空文件", async () => {
      await page.locator("#nav-evidence").click(); await page.locator("#evidenceSearch").fill("不存在的车型__audit");
      await until(() => page.locator("#exportCsv").isDisabled());
      await textMatches(page, "#evidenceTableWrap", /清除搜索/);
      await page.locator("#evidenceSearch").fill(""); await until(async () => !await page.locator("#exportCsv").isDisabled());
      if (await page.locator("#nextPage").isEnabled()) await page.locator("#nextPage").click();
      await page.locator("#modelFilter").selectOption({index: 1}); await textMatches(page, "#evidencePageInfo", /第 1 \/ /);
    });
    await reset();
    for (const metric of ["留存大定", "交车锁单"]) {
      await check(metric + " CSV原值与当前筛选一致，且导出不限当前页", async () => {
        const button = page.locator('[data-metric="' + metric + '"]'); if (await button.isDisabled()) return;
        await button.click(); await page.locator("#nav-evidence").click();
        const expected = await page.evaluate(metric => {
          const $ = id => document.getElementById(id).value;
          const category = $("categoryFilter"), model = $("modelFilter"), stage = $("stageFilter"), from = $("dateStart"), to = $("dateEnd");
          const map = new Map(window.PATTERNS_DATA.grouping.entries.map(x => [x.model, x.category]));
          return window.PATTERNS_DATA.series.filter(r => r.metric === metric && r.stage === stage && r.date >= from && r.date <= to && (model === "__ALL__" || r.model === model) && (category === "__ALL__" || map.get(r.model) === category));
        }, metric);
        assert.ok(expected.length > 0);
        const event = page.waitForEvent("download"); await page.locator("#exportCsv").click(); const download = await event;
        assert.equal(await download.failure(), null); const stream = await download.createReadStream(), chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const records = parseCsv(Buffer.concat(chunks).toString("utf8")); assert.equal(records.length, expected.length + 1);
        const actual = records.slice(1).map(r => ({date: r[0], model: r[1], value: Number(r[5]), source: r[7]}));
        assert.deepEqual(actual, expected.map(r => ({date: r.date, model: r.model, value: r.value, source: r.source})));
        await textMatches(page, "#actionStatus", /下载已交给浏览器/);
      });
    }
    await check("网页分析依据覆盖原Excel内容并联动全局筛选及原值导出", async () => {
      await reset();assert.equal(await page.locator('a[href$=".xlsx"]').count(),0);
      assert.ok(await page.locator("#overviewRuleCard").isVisible());
      await page.locator("#nav-evidence").click();await page.locator("#openLibrary").click();assert.equal(await page.locator("#libraryControls").isVisible(),true);
      const datasetKeys=await page.locator("#libraryTable option").evaluateAll(xs=>xs.map(x=>x.value));assert.ok(datasetKeys.length>=20);assert.ok(datasetKeys.includes("monthProgress"));
      assert.match(await page.locator("#libraryControls").innerText(),/全局/);
      for(const key of datasetKeys){
        await page.locator("#libraryTable").selectOption(key);
        assert.ok(await page.locator("#evidenceMeta").innerText());
        assert.ok(await page.locator("#evidenceTableWrap th").count()>0,key);
      }
      await page.locator("#libraryTable").selectOption("comparisons");
      const expected=await page.evaluate(()=>{
        const metric=new URLSearchParams(location.hash.slice(1)).get("metric"),stage=document.getElementById("stageFilter").value,from=document.getElementById("dateStart").value,to=document.getElementById("dateEnd").value;
        return (window.PATTERNS_DATA.results.period_comparisons||[]).filter(r=>r.metric===metric&&r.stage===stage&&(r.previous_start||r.start)>=from&&r.end<=to);
      });
      assert.equal(await page.locator("#evidenceTableWrap tbody tr").count(),Math.min(100,expected.length));
      const event=page.waitForEvent("download");await page.locator("#exportCsv").click();const download=await event;assert.equal(await download.failure(),null);
      const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
      const records=parseCsv(Buffer.concat(chunks).toString("utf8"));assert.equal(records.length,expected.length+1);
      const currentIndex=records[0].indexOf("本期量"),ratioIndex=records[0].indexOf("日均比");
      for(let i=0;i<expected.length;i++){assert.equal(Number(records[i+1][currentIndex]),expected[i].current);assert.equal(records[i+1][ratioIndex],expected[i].daily_ratio==null?"":String(expected[i].daily_ratio));}
      await page.reload();assert.equal(await page.locator("#libraryTable").inputValue(),"comparisons");
      await page.locator("#openMethods").click();assert.equal(await page.locator("#libraryTable").inputValue(),"coverage");
      await page.locator("#libraryMethods summary").click();assert.match(await page.locator("#libraryMethods").innerText(),/SHA-256/);
      await capture(page,"sales-full-library-methods.png");
      await page.locator("#libraryTable").selectOption("months");await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,"sales-full-library-mobile.png");
      await page.setViewportSize({width:1440,height:1000});await reset();
    });
    await check("快速连续切换最终状态正确，减少动效后无动画", async () => {
      await page.evaluate(() => ["patterns", "forecast", "evidence", "overview"].forEach(key => document.getElementById("nav-" + key).click()));
      assert.equal(await page.locator("#pageTitle").innerText(), "研究首页");
      // Clear the short update animation created by the preceding rapid switch before enabling reduced motion.
      await page.waitForTimeout(220);
      await page.emulateMedia({reducedMotion: "reduce"});
      await page.waitForTimeout(30);
      await page.locator("#nav-patterns").click(); await choosePattern(page,"week");
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      const transition = await page.locator("#nav-patterns").evaluate(e => getComputedStyle(e).transitionDuration);
      assert.equal(transition, "0s"); await page.emulateMedia({reducedMotion: "no-preference"});
    });
    const sizes = [[320,740],[375,812],[390,844],[768,1024],[844,390],[1440,1000],[1920,1080],[2560,1440],[3840,2160]];
    for (const [width,height] of sizes) {
      await check(width + "×" + height + " 四页布局与触摸导航", async () => {
        const p = await context.newPage(); await p.setViewportSize({width,height}); await p.goto(url);
        if (width <= 850) assert.equal(await p.locator("#toggleFilters").getAttribute("aria-expanded"), "false", "mobile filters should default to collapsed");
        if (width === 390) await capture(p, "sales-ui-after-mobile.png");
        for (const name of ["overview", "patterns", "forecast", "evidence"]) {
          await p.locator("#nav-" + name).click();
          if(name==="patterns"){await ensureFiltersOpen(p);await p.locator("#stageFilter").selectOption("首销");await choosePattern(p,"launch");if(width===390)await capture(p,"sales-launch-mobile.png");}
          assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + " has document overflow");
          assert.equal(await p.locator("#panel-" + name).isVisible(), true);
          if (width >= 1920) {
            const geometry = await p.evaluate(() => {
              const workspace = document.querySelector(".workspace");
              const panel = document.querySelector(".page-panel:not([hidden])");
              const workspaceRect = workspace.getBoundingClientRect();
              const panelRect = panel.getBoundingClientRect();
              const style = getComputedStyle(workspace);
              const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
              const paddingRight = Number.parseFloat(style.paddingRight) || 0;
              return {
                viewportRight: document.documentElement.clientWidth,
                workspaceRight: workspaceRect.right,
                panelLeft: panelRect.left,
                panelRight: panelRect.right,
                contentLeft: workspaceRect.left + paddingLeft,
                contentRight: workspaceRect.right - paddingRight,
              };
            });
            assert.ok(Math.abs(geometry.workspaceRight - geometry.viewportRight) <= 1, name + " workspace does not reach the viewport right edge");
            assert.ok(Math.abs(geometry.panelLeft - geometry.contentLeft) <= 1 && Math.abs(geometry.panelRight - geometry.contentRight) <= 1, name + " content panel does not fill the workspace content area");
          }
          const lowContrast = await p.evaluate(() => {
            const rgb = s => (s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
            const light = c => c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
            return [...document.querySelectorAll(".card-subtitle,.chart-caption,.chart-empty,.table-empty,.page-footer,.pattern-card p,.forecast-kpi span")].filter(e=>e.getClientRects().length).map(e=>{
              const fg=light(rgb(getComputedStyle(e).color));let parent=e,bg="";
              while(parent){bg=getComputedStyle(parent).backgroundColor;if(bg!=="rgba(0, 0, 0, 0)"&&bg!=="transparent")break;parent=parent.parentElement;}
              const b=light(rgb(bg||"rgb(255,255,255)"));return {selector:e.className||e.tagName,ratio:(Math.max(fg,b)+.05)/(Math.min(fg,b)+.05)};
            }).filter(r=>r.ratio<4.5);
          });
          assert.deepEqual(lowContrast, [], name + " has unreadable supporting text");
        }
        if (width <= 850) {
          await ensureFiltersOpen(p);
          const bounds = await p.locator(".nav-item").evaluateAll(nodes => nodes.map(e => ({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,right:e.getBoundingClientRect().right,left:e.getBoundingClientRect().left})));
          assert.ok(bounds.every(r => r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= width));
          const inputs = await p.locator("#categoryFilter,#modelFilter,#stageFilter,#dateStart,#dateEnd,#exportCsv").evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().height));
          assert.ok(inputs.every(height => height >= 44));
        }
        await p.close();
      });
    }
    await page.goto(url); await page.locator("#nav-forecast").click(); await page.locator("#trialBase").fill("100");
    await textMatches(page, "#trialResult", /3,000 辆/); await capture(page, "sales-ui-after-forecast.png");
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    console.log(JSON.stringify({passed:completed.length,checks:completed,consoleErrors:errors,networkRequests:requests},null,2));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode = 1;});
