/* Development-only browser checks: synthetic HTTP fixtures, no workbook/report input.
   PLAYWRIGHT_MODULE and BROWSER_BINARY can point to local development dependencies. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const V1 = "a".repeat(64), V2 = "b".repeat(64), V3 = "c".repeat(64);
const metric = "fixture-metric";
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause();
  }
  assert.ok(await predicate(), message || "Expected browser state was not reached");
}

(async () => {
  const liveScript = await fs.readFile(path.join(__dirname, "../dynamic/live_reload.js"), "utf8");
  let state;
  function reset() {
    state = {reportVersion: V1, status: {app: "sales-patterns", version: V1, state: "ready", source_id: "fixture-source", project_id: "fixture-project"},
      requests: 0, documents: 0, active: 0, maxActive: 0, mode: "ok"};
  }
  reset();
  function html(withMeta = true) {
    const version = state.reportVersion;
    const end = version === V1 ? "2026-01-10" : "2026-01-11";
    const fields = version ? '<input id="dateStart" type="date"><input id="dateEnd" type="date">' +
      '<input id="evidenceSearch"><select id="forecastModel"><option value="' + version + '">' + version + '</option></select>' +
      '<input id="trialBase" type="number"><input id="trialDays" type="number" value="30">' +
      '<input id="trialFactor" type="number" value="1">' +
      '<input type="radio" name="trialMode" value="daily" checked><input type="radio" name="trialMode" value="period">' +
      '<output id="trialResult"></output>' : "";
    return '<!doctype html><html><head>' + (withMeta ? '<meta name="sales-patterns-live-version" content="' + (version || "pending") + '">' : "") +
      '</head><body>' + fields + '<script>' +
      (version ? 'window.PATTERNS_DATA = {series: [{metric:"fixture-metric",date:"2026-01-01"},' +
        '{metric:"fixture-metric",date:"' + end + '"},{metric:"other-metric",date:"2020-01-01"},' +
        '{metric:"other-metric",date:"2030-01-01"}]};' +
        'const params = new URLSearchParams(location.hash.slice(1));params.set("metric",params.get("metric")||"fixture-metric");' +
        'dateStart.value=params.get("start")||"2026-01-01";dateEnd.value=params.get("end")||"' + end + '";' +
        'params.set("start",dateStart.value);params.set("end",dateEnd.value);' +
        'evidenceSearch.value=params.get("search")||"";history.replaceState(null,"","#"+params.toString());' +
        'function updateTrial(){trialResult.textContent=JSON.stringify({base:trialBase.value,days:trialDays.value,factor:trialFactor.value,' +
        'mode:document.querySelector(\'input[name="trialMode"]:checked\').value});}' +
        'document.querySelectorAll(\'input[name="trialMode"]\').forEach(input=>input.addEventListener("change",updateTrial));' +
        '["trialBase","trialDays","trialFactor"].forEach(id=>document.getElementById(id).addEventListener("input",updateTrial));updateTrial();' : "") +
      '</script><script>' + liveScript + '</script></body></html>';
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      const requestState = state;
      requestState.requests++;
      requestState.active++;
      requestState.maxActive = Math.max(requestState.maxActive, requestState.active);
      res.on("close", () => { requestState.active--; });
      if (requestState.mode === "hang") return;
      if (requestState.mode === "disconnect") { req.socket.destroy(); return; }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (requestState.mode === "http-error") { res.writeHead(503); res.end("{}"); }
      else if (requestState.mode === "invalid-json") res.end("{");
      else {
        const status = requestState.statusOnce || requestState.status;
        requestState.statusOnce = null;
        res.end(JSON.stringify(status));
      }
      return;
    }
    if (req.url === "/" || req.url === "/static") {
      state.documents++;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(html(req.url !== "/static"));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch(process.env.BROWSER_BINARY ?
    {executablePath: process.env.BROWSER_BINARY, headless: true} : {channel: "chrome", headless: true});
  const errors = [];
  let context, tempDir;
  async function open(route = "/") {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install({time: new Date("2026-11-11T00:00:00Z")});
    await page.clock.pauseAt(new Date("2026-11-11T00:00:01Z"));
    await page.goto(origin + route);
    await pause();
    return page;
  }
  async function poll(page) {
    const before = state.requests;
    await page.clock.runFor(15000);
    await until(() => state.requests > before, "Poll did not request status");
    await pause();
  }
  async function close() { await context.close(); reset(); }
  async function versionOf(page) {
    return page.locator('meta[name="sales-patterns-live-version"]').getAttribute("content");
  }
  function publish(version = V2) { state.reportVersion = version; state.status.version = version; }

  try {
    let page = await open();
    const initialRequests = state.requests;
    await page.clock.runFor(14999);
    await pause();
    assert.equal(state.requests, initialRequests, "Visible page must wait the full 15 seconds");
    await page.clock.runFor(1);
    await until(() => state.requests > initialRequests, "Visible page must poll at 15 seconds");
    assert.equal(state.documents, 1, "Unchanged reports must not reload");

    for (const mode of ["http-error", "invalid-json", "disconnect"]) {
      state.mode = mode;
      await poll(page);
      assert.equal(state.documents, 1, mode + " must retain the current page");
    }
    state.mode = "ok";
    for (const status of [
      {app: "other-app", version: V2},
      {app: "sales-patterns", version: null},
      {app: "sales-patterns", version: ""},
      {app: "sales-patterns", version: "invalid"}
    ]) {
      state.status = status;
      await poll(page);
      assert.equal(state.documents, 1, "Only a published version from this app can reload");
    }
    state.status = {app: "sales-patterns", version: V1};
    publish();
    await poll(page);
    await until(async () => await versionOf(page) === V2);
    assert.equal(state.documents, 2, "Published version must reload once");
    await poll(page);
    assert.equal(state.documents, 2, "Reloaded version must remain stable");
    assert.equal(state.maxActive, 1, "Status requests must not overlap");
    await close();

    const route = new URLSearchParams({page: "evidence", pattern: "launch", metric, model: "fixture-model",
      category: "fixture-group", stage: "fixture-stage", start: "2026-01-02", end: "2026-01-08",
      search: "fixture & search", pageNo: "2"});
    page = await open("/#" + route);
    await page.locator("#trialBase").fill("125.5");
    await page.locator("#trialDays").fill("14");
    await page.locator("#trialFactor").fill("0");
    await page.locator('input[name="trialMode"][value="period"]').check();
    const originalHash = await page.evaluate(() => location.hash);
    publish();
    await poll(page);
    await until(async () => await versionOf(page) === V2);
    assert.equal(await page.evaluate(() => location.hash), originalHash);
    assert.equal(await page.locator("#evidenceSearch").inputValue(), "fixture & search");
    assert.equal(await page.locator("#trialBase").inputValue(), "125.5");
    assert.equal(await page.locator("#trialDays").inputValue(), "14");
    assert.equal(await page.locator("#trialFactor").inputValue(), "0");
    assert.equal(await page.locator('input[name="trialMode"]:checked').inputValue(), "period");
    assert.deepEqual(JSON.parse(await page.locator("#trialResult").textContent()),
      {base: "125.5", days: "14", factor: "0", mode: "period"}, "Existing form events must run");
    assert.equal(await page.locator("#forecastModel").inputValue(), V2, "New report selections must remain current");
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, "Draft must be consumed once");

    await page.locator("#trialBase").fill("0");
    await page.locator("#trialDays").fill("");
    await page.locator("#trialFactor").fill("");
    await page.locator('input[name="trialMode"][value="daily"]').check();
    publish(V3);
    await poll(page);
    await until(async () => await versionOf(page) === V3);
    assert.deepEqual(JSON.parse(await page.locator("#trialResult").textContent()),
      {base: "0", days: "", factor: "", mode: "daily"}, "Zero and blank values must survive");
    await page.reload();
    assert.equal(await page.locator("#trialBase").inputValue(), "", "Manual reload must not replay an old draft");
    await close();

    page = await open();
    await page.locator("#trialBase").fill("0");
    await page.locator("#trialDays").fill("");
    await page.locator("#trialFactor").fill("");
    await page.locator('input[name="trialMode"][value="period"]').check();
    publish(V3);
    // The poll sees V2, but the HTML request already receives V3.
    state.statusOnce = {app: "sales-patterns", version: V2};
    await poll(page);
    await until(async () => await versionOf(page) === V3);
    assert.deepEqual(JSON.parse(await page.locator("#trialResult").textContent()),
      {base: "0", days: "", factor: "", mode: "period"}, "A newer HTML version must restore the same draft");
    assert.equal(state.documents, 2);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, "Skipped-version draft must be consumed once");
    await close();

    page = await open("/#" + new URLSearchParams({page: "patterns", metric, start: "2026-01-01", end: "2026-01-10", search: "keep", pageNo: "3"}));
    publish();
    await poll(page);
    await until(async () => await versionOf(page) === V2);
    assert.equal(await page.locator("#dateStart").inputValue(), "2026-01-01");
    assert.equal(await page.locator("#dateEnd").inputValue(), "2026-01-11", "Full history must include the added date");
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("pageNo")), "3");
    await close();

    state.reportVersion = null; state.status.version = null;
    page = await open();
    assert.equal(await versionOf(page), "pending");
    assert.equal(await page.locator("#trialBase").count(), 0);
    await page.evaluate(({version}) => sessionStorage.setItem("sales-patterns-live-trial:v1:/",
      JSON.stringify({version, values: {trialBase: "0", trialDays: "", trialFactor: "0"}, mode: "period"})), {version: V2});
    await page.reload();
    assert.equal(await page.evaluate(() => sessionStorage.length), 1, "Pending page must retain the draft");
    publish(V3);
    await poll(page);
    await until(async () => await versionOf(page) === V3);
    assert.deepEqual(JSON.parse(await page.locator("#trialResult").textContent()), {base: "0", days: "", factor: "0", mode: "period"});
    await close();

    page = await open("/static");
    await page.clock.runFor(60000);
    assert.equal(state.requests, 0, "HTTP without the live marker must never poll");
    await close();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sales-live-fixture-"));
    const offlinePath = path.join(tempDir, "offline.html");
    await fs.writeFile(offlinePath, html());
    page = await open("/static");
    let offlineRequests = 0;
    page.on("request", request => { if (/^https?:/.test(request.url())) offlineRequests++; });
    await page.goto(pathToFileURL(offlinePath).href);
    await page.clock.runFor(60000);
    assert.equal(offlineRequests, 0, "file:// reports must never poll, even with a marker");
    await close();

    page = await open();
    state.mode = "hang";
    await poll(page);
    const hangingRequests = state.requests;
    await page.clock.runFor(5000);
    assert.equal(state.requests, hangingRequests, "Slow fetch must not start a second poll");
    await page.clock.runFor(5000);
    await until(() => state.active === 0, "Timed out request must be aborted");
    state.mode = "ok";
    await poll(page);
    assert.equal(state.maxActive, 1);
    await close();

    page = await open();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenRequests = state.requests;
    await page.clock.runFor(60000);
    assert.equal(state.requests, hiddenRequests, "Hidden page must pause polling");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {configurable: true, get: () => false});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await until(() => state.requests > hiddenRequests, "Visible page must resume immediately");
    await pause();
    state.mode = "hang";
    await poll(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await until(() => state.active === 0, "pagehide must abort the active request");
    const hiddenPageRequests = state.requests;
    await page.clock.runFor(60000);
    assert.equal(state.requests, hiddenPageRequests, "pagehide must clear future polls");
    await close();

    assert.deepEqual(errors, [], "No unhandled browser errors");
    console.log("Live reload browser checks passed (versions, URL/form state, dates, offline, pending, timeout, lifecycle).");
  } finally {
    await context?.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (tempDir) { await fs.unlink(path.join(tempDir, "offline.html")); await fs.rmdir(tempDir); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
