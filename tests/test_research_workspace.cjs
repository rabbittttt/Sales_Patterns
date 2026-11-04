/* Research-workspace regression coverage. Production only needs the offline
   HTML; this file is a development check that injects a small source-shaped
   fixture so UI assertions do not depend on the sample workbook. */
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const project = path.resolve(__dirname, "..");
const reportPath = path.resolve(process.argv[2] || path.join(project, "output_file/鸿蒙智行销量规律分析.html"));
const date = (day) => `2025-02-${String(day).padStart(2, "0")}`;
const models = ["研究车型A", "研究车型B"];
const entries = models.map((model, i) => ({model, category: `研究分类${i + 1}`, metrics: ["小订数量", "留存大定", "交车锁单"], brand: "测试品牌", segment: i ? "SUV" : "轿车", energy: "纯电"}));
const metrics = [
  {key: "小订数量", label: "小订", source_label: "小订数量", available: true},
  {key: "留存大定", label: "留存大定", source_label: "留存大定", available: true},
  {key: "交车锁单", label: "锁单", source_label: "交车锁单", available: true}
];
const series = [];
for (const model of models) {
  [0, 2, 3, 4].forEach((value, i) => series.push({model, metric: "小订数量", date: date(i + 1), stage: "小订阶段", cycle: "小订批次", source: "小订源表", value, life: i + 1}));
  for (let i = 0; i < 6; i++) {
    series.push({model, metric: "留存大定", date: date(i + 1), stage: "首销", cycle: "首销批次", source: "大定源表", value: 20 + i, life: i + 1});
    series.push({model, metric: "交车锁单", date: date(i + 1), stage: "首销", cycle: "锁单批次", source: "锁单源表", value: 10 + i, life: i + 1});
  }
  // Keep an independent post-launch phase so a launch-stage selection can be tested
  // when navigating back to the overview and into a calendar topic.
  for (let i = 6; i < 8; i++) {
    series.push({model, metric: "留存大定", date: date(i + 1), stage: "平销", cycle: "首销批次", source: "大定源表", value: 26 + i, life: i + 1});
    series.push({model, metric: "交车锁单", date: date(i + 1), stage: "平销", cycle: "锁单批次", source: "锁单源表", value: 16 + i, life: i + 1});
  }
}
// Keep enough deterministic fixture rows to exercise pagination without using business data.
for (let i = 0; i < 120; i++) series.push({model: models[0], metric: "留存大定", date: date(1), stage: "首销", cycle: "搜索回归" + i, source: "大定源表", value: 1, life: 1});
const hourly = [];
for (const model of models) {
  for (const [metric, stage, day] of [["小订数量", "小订", 1], ["交车锁单", "首销", 2]]) {
    for (let hour = 0; hour < 24; hour++) hourly.push({
      model, metric, stage, date: date(day), hour, value: 1, share: 1 / 24, total: 24,
      observed_hours: 24, expected_hours: 24, status: "有效", group_status: "有效", source: `${metric}小时源表`, source_sheet: `${metric}by时`
    });
  }
}
const curves = [1, 2, 3].map(day => ({model: models[0], metric: "小订数量", stage: "小订", curve: "小订累计完成度", day, date: date(day), value: day / 3, unit: "比例", source: "小订曲线源表", status: "有效", denominator: 3}));
curves.push(...[1, 2, 3].map(day => ({model: models[0], metric: "小订数量", stage: "小订", curve: "小订期累计退订率", day, date: date(day), value: day / 10, unit: "比例", source: "小订曲线源表", status: "有效", denominator: 10})));
curves.push({model: models[0], metric: "小订数量", stage: "小订", curve: "小订累计完成度", value: 999, unit: "比例", source: "小订曲线源表", status: "未知"});
const launchPeriods = [];
const launchPacing = [];
const periodComparisons = [];
for (const model of models) {
  for (const metric of ["留存大定", "交车锁单"]) {
    launchPeriods.push({model, metric, stage: "首销", cycle: "首销批次", source: "上市源表", period_no: 1, grain: "周", start: date(1), end: date(6), observed_start: date(1), observed_end: date(6), current: metric === "留存大定" ? 135 : 75, daily_avg: metric === "留存大定" ? 22.5 : 12.5, observed: 6, expected_days: 7, status: "有效"});
    launchPeriods.push({model, metric, stage: "首销", cycle: "首销批次", source: "上市源表", period_no: 1, grain: "月", start: date(1), end: date(6), observed_start: date(1), observed_end: date(6), current: metric === "留存大定" ? 135 : 75, daily_avg: metric === "留存大定" ? 22.5 : 12.5, observed: 6, expected_days: 6, status: "有效"});
    launchPacing.push({model, metric, stage: "首销", previous_stage: "首销", current_stage: "首销", cycle: "首销批次", source: "上市源表", grain: "周", pattern: "上市第2周/第1周", previous_start: date(1), previous_end: date(2), start: date(3), end: date(6), previous: 30, current: 60, ratio: 2, daily_ratio: 2, previous_observed: 2, previous_days: 2, current_observed: 4, current_days: 4, status: "有效"});
    launchPacing.push({model, metric, stage: "首销", previous_stage: "首销", current_stage: "首销", cycle: "首销批次", source: "上市源表", grain: "月", pattern: "上市第2月/第1月", previous_start: date(1), previous_end: date(2), start: date(3), end: date(6), previous: 30, current: 60, ratio: 2, daily_ratio: 2, previous_observed: 2, previous_days: 2, current_observed: 4, current_days: 4, status: "有效"});
    for (const grain of ["周", "月"]) periodComparisons.push({model, metric, stage: "首销", cycle: "首销批次", source: "周期源表", kind: grain, transition: "首销→首销", start: grain === "周" ? date(1) : date(1), end: date(6), previous_start: date(1), previous_end: date(2), current: 60, previous: 30, current_days: 4, current_observed: 4, previous_days: 2, previous_observed: 2, ratio: 2, daily_ratio: 2, holiday_adjusted_days: 0, current_negative_days: 0, previous_negative_days: 0, status: "有效"});
  }
}
const emptyResults = {
  coverage: [], weekly: [], monthly: [], annual: [], holidays: [], lifecycle: [], lock_lags: [], period_comparisons: periodComparisons, period_summary: [],
  month_progress: [], launch_periods: launchPeriods, launch_pacing: launchPacing, model_classes: entries, period_coverage: []
};
const fixture = {
  meta: {source_name: "UI研究工作台夹具", date_start: date(1), date_end: date(8), analysis_start: date(1), analysis_end: date(8), generated_at: "2025-03-01T09:00:00", calendar_events: []},
  metrics, series, rules: [], grouping: {entries, categories: entries.map(x => x.category), reason: "测试夹具"},
  results: emptyResults, forecast: {profiles: [{model: models[0], metric: "小订数量", stage: "小订阶段", grain: "日", cycle: "小订批次", source: "小订源表", cutoff: "2026-08-30", as_of: "2026-08-30", last_observation: date(4), small_end: date(4), target_start: null, target_end: null, baseline: null, estimate: null, train_samples: 4, status: "no_complete_target_period", tail_note: "小订期结束于 " + date(4) + "，最后观测日为 " + date(4) + "，不使用全局截止日。"}], backtests: [], notes: []},
  source_insights: {inventory: [], early_launch: [], curves, hourly, notes: []}
};

async function waitFor(page, predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.ok(await predicate(), "Expected UI state was not reached");
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
async function ensureFiltersOpen(page) {
  const toggle = page.locator("#toggleFilters");
  if (!(await toggle.count()) || !(await toggle.isVisible())) return;
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

(async () => {
  const browser = await chromium.launch(process.env.BROWSER_BINARY ? {executablePath: process.env.BROWSER_BINARY, headless: true} : {channel: "chrome", headless: true});
  const requests = [], errors = [];
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  context.on("request", request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage();
  const url = pathToFileURL(reportPath).href;
  await page.addInitScript(({fixture}) => {
    let current;
    Object.defineProperty(window, "PATTERNS_DATA", {
      configurable: true,
      get: () => current,
      set: () => { current = fixture; }
    });
  }, {fixture});
  try {
    await page.goto(url);
    await waitFor(page, () => page.locator("#resetFilters").count().then(Boolean));

    assert.equal(await page.locator("[data-metric]").count(), 3);
    assert.deepEqual(await page.locator("[data-metric]").allTextContents(), ["小订", "留存大定", "锁单"]);

    await page.locator('[data-metric="小订数量"]').click();
    assert.equal(await page.locator("#stageFilter").inputValue(), "小订阶段");
    assert.deepEqual(await page.locator("#stageFilter option").allTextContents(), ["小订期"]);
    assert.ok((await page.locator("#evidenceMeta").count()) >= 1);
    const sameDayStages = await page.evaluate(() => {
      const rows = window.PATTERNS_DATA.series.filter(r => r.date === "2025-02-01");
      return Object.fromEntries(rows.map(r => [r.metric, r.stage]));
    });
    assert.equal(sameDayStages["小订数量"], "小订阶段");
    assert.equal(sameDayStages["留存大定"], "首销");
    assert.equal(await page.evaluate(() => window.PATTERNS_DATA.series.some(r => r.metric === "小订数量" && r.value === 0)), true);

    await page.locator("#nav-evidence").click();
    const smallDailyRows = await page.locator("#evidenceTableWrap .data-table tbody tr").evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.innerText)));
    assert.ok(smallDailyRows.some(row => row[0] === date(1) && row[5] === "0"), "真实0应在逐日证据中保留");
    await page.locator('[data-evidence="library"]').click();
    await page.locator("#libraryTable").selectOption("sourceCurves");
    assert.match(await page.locator("#evidenceTableWrap").innerText(), /日期未知，仅保留核对，不参与当前日期窗统计/);
    await page.locator("#nav-overview").click();

    await page.locator('[data-metric="留存大定"]').click();
    assert.ok((await page.locator("#stageFilter option").allTextContents()).includes("首销"));
    await page.locator("#modelFilter").selectOption("研究车型B");
    await page.locator('[data-metric="小订数量"]').click();
    assert.equal(await page.locator("#modelFilter").inputValue(), "研究车型B");

    await page.locator("#nav-patterns").click();
    for (const domain of ["calendar", "lifecycle", "orders"]) assert.equal(await page.locator("#domain-" + domain).isDisabled(), false, domain + " research domain should remain enterable");
    await page.locator("#domain-calendar").click();
    await page.locator("#pattern-week").click();
    assert.equal(await page.locator("#pattern-week").getAttribute("aria-selected"), "true");
    await page.locator("#domain-lifecycle").click();
    assert.equal(await page.locator("#domain-lifecycle").getAttribute("aria-selected"), "true");
    await page.locator("#pattern-hourly").click();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("pattern"), "hourly");
    await page.locator("#domain-calendar").click();
    assert.equal(await page.locator("#pattern-week").getAttribute("aria-selected"), "true", "calendar domain should remember its last topic");
    await page.locator("#domain-orders").click();
    assert.equal(await page.locator("#domain-orders").getAttribute("aria-selected"), "true");
    assert.match(await page.locator("#patternPanels").innerText(), /小订|不适用/, "an unavailable order topic must explain its scope instead of silently disabling the domain");
    await page.reload();
    assert.equal(await page.locator("#domain-orders").getAttribute("aria-selected"), "true");
    await page.locator('[data-metric="留存大定"]').click();
    await page.locator("#domain-orders").click();
    await page.locator("#pattern-lags").click();
    assert.equal(await page.locator("#pattern-lags").getAttribute("aria-selected"), "true");

    await page.locator("#nav-overview").click();
    for (const id of ["overviewInsight", "ratioSummary", "modelCompare", "overviewSignals"]) assert.equal(await page.locator("#" + id).count(), 0, id + " should not be on the homepage");
    assert.match(await page.locator("#overviewRuleCard").innerText(), /当前范围发现了什么/);

    await page.locator('[data-metric="留存大定"]').click();
    await page.locator("#modelFilter").selectOption("研究车型A");
    await page.locator("#dateStart").fill(date(1)); await page.locator("#dateStart").dispatchEvent("change");
    await page.locator("#dateEnd").fill(date(4)); await page.locator("#dateEnd").dispatchEvent("change");
    await page.locator("#nav-patterns").click(); await page.locator("#domain-calendar").click(); await page.locator("#pattern-months").click();
    const beforeEvidence = [await page.locator("#modelFilter").inputValue(), await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()];
    await page.getByRole("button", {name: "核对本专题证据"}).click();
    assert.equal(await page.locator("#nav-evidence").getAttribute("aria-selected"), "true");
    assert.deepEqual([await page.locator("#modelFilter").inputValue(), await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()], beforeEvidence);

    // A topic hand-off must carry the exact source curve, grain and search scope into evidence.
    await page.locator("#resetFilters").click();
    await page.locator("#nav-patterns").click();
    await page.locator('[data-metric="小订数量"]').click();
    await page.locator("#domain-lifecycle").click(); await page.locator("#pattern-structure").click();
    const curveSelect = page.locator('select[aria-label="小订研究曲线"]');
    assert.ok(await curveSelect.count(), "small-order curve selector should be rendered");
    await curveSelect.selectOption("小订累计完成度");
    await page.getByRole("button", {name: "核对本专题证据"}).click();
    assert.equal(await page.locator("#libraryTable").inputValue(), "sourceCurves");
    assert.equal(await page.locator("#libraryMetric").inputValue(), "小订累计完成度");
    const curveEvidence = await page.locator("#evidenceTableWrap table").evaluate(table => {
      const headers = [...table.querySelectorAll("thead th")].map(cell => cell.textContent.trim());
      const curveIndex = headers.indexOf("曲线");
      return {headers, curves: [...table.querySelectorAll("tbody tr")].map(row => row.cells[curveIndex]?.textContent.trim()).filter(Boolean)};
    });
    assert.ok(curveEvidence.curves.length >= 3);
    assert.ok(curveEvidence.curves.every(curve => curve === "小订累计完成度"), "evidence must stay on the selected source curve");
    const curveDownloadEvent = page.waitForEvent("download"); await page.locator("#exportCsv").click(); const curveDownload = await curveDownloadEvent;
    const curveStream = await curveDownload.createReadStream(), curveChunks = []; for await (const chunk of curveStream) curveChunks.push(chunk);
    const curveCsv = parseCsv(Buffer.concat(curveChunks).toString("utf8")), curveHeader = curveCsv[0].indexOf("曲线");
    assert.ok(curveHeader >= 0 && curveCsv.slice(1).every(row => row[curveHeader] === "小订累计完成度"));
    assert.equal(curveCsv.some(row => row.includes("小订期累计退订率")), false);

    await page.locator("#nav-patterns").click(); await page.locator('[data-metric="留存大定"]').click();
    await page.locator("#domain-lifecycle").click(); await page.locator("#pattern-launch").click();
    await page.locator("#launchGrain").selectOption("月");
    await page.getByRole("button", {name: "核对本专题证据"}).click();
    assert.equal(await page.locator("#libraryTable").inputValue(), "launchPeriods");
    assert.equal(await page.locator("#libraryGrain").inputValue(), "月");
    const launchEvidence = await page.locator("#evidenceTableWrap table").evaluate(table => {
      const headers = [...table.querySelectorAll("thead th")].map(cell => cell.textContent.trim());
      const grainIndex = headers.indexOf("上市粒度");
      return [...table.querySelectorAll("tbody tr")].map(row => row.cells[grainIndex]?.textContent.trim()).filter(Boolean);
    });
    assert.ok(launchEvidence.length > 0 && launchEvidence.every(grain => grain === "月"));

    await page.locator("#nav-patterns").click(); await page.locator("#domain-calendar").click(); await page.locator("#pattern-cycles").click();
    await page.locator("#stageFilter").selectOption("首销");
    await page.locator("#trendGrain").selectOption("周");
    await page.getByRole("button", {name: "核对本专题证据"}).click();
    assert.equal(await page.locator("#libraryTable").inputValue(), "comparisons");
    assert.equal(await page.locator("#libraryGrain").inputValue(), "周");
    const cycleEvidence = await page.locator("#evidenceTableWrap table").evaluate(table => {
      const headers = [...table.querySelectorAll("thead th")].map(cell => cell.textContent.trim());
      const grainIndex = headers.indexOf("周期");
      return [...table.querySelectorAll("tbody tr")].map(row => row.cells[grainIndex]?.textContent.trim()).filter(Boolean);
    });
    assert.ok(cycleEvidence.length > 0 && cycleEvidence.every(grain => grain === "周"));

    // Search and pagination are route state, not transient DOM state.
    await page.locator("#resetFilters").click(); await page.locator("#nav-evidence").click(); await page.locator('[data-evidence="daily"]').click();
    await page.locator("#stageFilter").selectOption("首销");
    await page.locator("#evidenceSearch").fill("搜索回归");
    await waitFor(page, () => page.locator("#evidencePageInfo").innerText().then(text => /第 1 \/ 2 页/.test(text)));
    await page.locator("#nextPage").click();
    const searchAndPage = [await page.locator("#evidenceSearch").inputValue(), await page.locator("#evidencePageInfo").innerText()];
    await page.reload();
    assert.deepEqual([await page.locator("#evidenceSearch").inputValue(), await page.locator("#evidencePageInfo").innerText()], searchAndPage);
    await page.locator("#nav-patterns").click(); await page.goBack();
    await waitFor(page, () => page.locator("#nav-evidence").getAttribute("aria-selected").then(value => value === "true"));
    assert.deepEqual([await page.locator("#evidenceSearch").inputValue(), await page.locator("#evidencePageInfo").innerText()], searchAndPage);

    // Each metric remembers its own custom date window through reload and switching.
    await page.locator('[data-metric="留存大定"]').click();
    await page.locator("#dateStart").fill(date(2)); await page.locator("#dateStart").dispatchEvent("change");
    await page.locator("#dateEnd").fill(date(5)); await page.locator("#dateEnd").dispatchEvent("change");
    const depositDates = [await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()];
    await page.locator('[data-metric="小订数量"]').click();
    await page.locator("#dateStart").fill(date(1)); await page.locator("#dateStart").dispatchEvent("change");
    await page.locator("#dateEnd").fill(date(3)); await page.locator("#dateEnd").dispatchEvent("change");
    const smallDates = [await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()];
    await page.reload();
    assert.deepEqual([await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()], smallDates);
    await page.locator('[data-metric="留存大定"]').click();
    assert.deepEqual([await page.locator("#dateStart").inputValue(), await page.locator("#dateEnd").inputValue()], depositDates);

    await page.locator('[data-metric="小订数量"]').click(); await page.locator("#nav-forecast").click();
    const smallForecastText = await page.locator("#forecastSelection,#forecastProfileNote,#forecastEmpty").allTextContents();
    assert.doesNotMatch(smallForecastText.join(" "), /最新预测时点（2026-08-30）/);
    assert.match(smallForecastText.join(" "), /小订期|小订结束|小订观测至|最后观测|最后观测日|建议.*日/);

    await page.locator("#nav-patterns").click(); await page.locator("#domain-lifecycle").click();
    await page.locator('[data-metric="小订数量"]').click();
    await page.locator("#pattern-structure").click();
    assert.doesNotMatch(await page.locator("#patternPanels").innerText(), /999/, "未知日期曲线不能进入图表统计");
    await page.locator("#pattern-hourly").click();
    await page.locator('[data-metric="交车锁单"]').click();
    assert.equal(await page.locator("#patternPanels .pattern-card").first().locator(".data-table tbody tr").count(), 24);
    await page.locator('[data-metric="留存大定"]').click();
    assert.match(await page.locator("#patternPanels").innerText(), /源表没有.*留存大定|不会使用.*替代/);
    await page.locator('[data-metric="交车锁单"]').click();
    await page.locator("#dateStart").fill(date(1)); await page.locator("#dateStart").dispatchEvent("change");
    await page.locator("#dateEnd").fill(date(1)); await page.locator("#dateEnd").dispatchEvent("change");
    assert.equal(await page.locator("#patternPanels .data-table").count(), 0);
    assert.match(await page.locator("#patternPanels").innerText(), /没有完整有效的24小时记录|没有完整分时样本|源表没有|源表未提供/);

    const hourlyCoverage = await page.evaluate(() => {
      const groups = new Map();
      for (const r of window.PATTERNS_DATA.source_insights.hourly) {
        const key = [r.metric, r.model, r.date].join("|");
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      return [...groups.entries()];
    });
    assert.ok(hourlyCoverage.some(([key, count]) => key.startsWith("小订数量|") && count === 24));
    assert.ok(hourlyCoverage.some(([key, count]) => key.startsWith("交车锁单|") && count === 24));

    await page.locator("#resetFilters").click();
    for (const width of [1366, 1920, 2560, 390]) {
      await page.setViewportSize({width, height: 900});
      await page.locator("#nav-overview").click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow at ${width}px`);
      if (width === 390) {
        const toggle = page.locator("#toggleFilters");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false", "mobile filters should start collapsed");
        assert.equal(await page.locator("#filterFields").isVisible(), false);
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        assert.equal(await page.locator("#filterFields").isVisible(), true);
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      }
    }
    await page.locator("#nav-forecast").click();
    await page.waitForTimeout(30);
    for (const width of [1366, 1920, 2560, 390]) {
      await page.setViewportSize({width, height: 900});
      const forecastOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(forecastOverflow, false, `forecast page overflows at ${width}px`);
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed: true, checks: 18, widths: [1366, 1920, 2560, 390]}));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
