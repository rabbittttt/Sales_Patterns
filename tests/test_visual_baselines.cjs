/* Windows/Chrome screenshots for the generated make_smoke_input.py report. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const golden = path.join(__dirname, "visual_baselines");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sales-visual-"));
  const browser = await chromium.launch({executablePath: process.env.BROWSER_BINARY, channel: "chrome"});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:960}, deviceScaleFactor:1, reducedMotion:"reduce", locale:"zh-CN"});
    await page.goto(pathToFileURL(path.join(root,"output_file","鸿蒙智行销量规律分析.html")).href);
    const models = await page.evaluate(() => [...new Set(window.PATTERNS_DATA.series.map(r => r.model))]);
    assert.deepEqual(models, ["样例车型"], "Use the synthetic delivery fixture for visual tests");
    await page.locator('[data-metric="留存大定"]').click();
    await page.locator("#nav-patterns").click();
    const topic = page.locator("#pattern-holiday");
    if (!await topic.isVisible()) await page.locator('[data-domain="calendar"]').click();
    await topic.click();
    await page.locator("details.research-detail > summary").filter({hasText:"节前、节中、节后日均指数（逐车型）"}).click();
    const axis = page.locator("#patternPanels .pattern-card").filter({has:page.getByRole("heading",{name:"节前、节中、节后日均指数（逐车型）",exact:true})}).locator(".pattern-chart");
    await axis.waitFor();
    assert.match(page.url(), /pattern=holiday/);
    assert.ok(await axis.locator(".bar-row").count(), "holiday fixture must render a chart");
    await page.evaluate(() => document.fonts.ready);
    for (const [name, region] of [["sidebar",page.locator(".sidebar-filters")],["holiday-axis",axis]]) {
      const current = path.join(folder, name+".png");
      await region.screenshot({path:current, animations:"disabled"});
      const expected = path.join(golden, name+".png");
      if (process.argv.includes("--update")) {
        await fs.mkdir(golden,{recursive:true});
        await fs.copyFile(current,expected);
      } else {
        const check = spawnSync(process.env.SALES_PATTERNS_PYTHON || "python",
          [path.join(__dirname,"compare_screenshot.py"),expected,current], {encoding:"utf8"});
        assert.equal(check.status,0,(check.stderr || check.error || "")+" "+name);
      }
    }
    console.log("Sidebar and holiday chart baselines passed.");
  } finally {
    await browser.close();
    await fs.rm(folder,{recursive:true,force:true});
  }
})().catch(e => {console.error(e);process.exitCode=1;});
