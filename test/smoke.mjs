// Headless smoke test: types a snippet with vim keys and checks completion.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(pathToFileURL(resolve("index.html")).href);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

await page.selectOption("#opt-indent-mode", "none");
const target = await page.evaluate(() => window.codetype.app.targetLines);
assert(target.length > 3, `loaded snippet (${target.length} lines)`);

await page.click("#typed .cm-content");
await page.keyboard.press("i");
// Type a wrong char first -> mistake, then fix.
await page.keyboard.type("dex");
assert(await page.locator("#typed .ch-error").count() > 0, "error is highlighted");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
assert(await page.locator("#typed .ch-error").count() === 0, "error cleared after fixing");
assert(await page.locator(".cm-ghost").count() === 1, "ghost text visible");

for (let i = 0; i < target.length; i++) {
  await page.keyboard.type(target[i]);
  if (i < target.length - 1) await page.keyboard.press("Enter");
}
await page.waitForTimeout(100);
assert(await page.locator("#results[open]").count() === 1, "results dialog shown on completion");
console.log("stats:", await page.locator(".results-grid").innerText().then((t) => t.replace(/\s+/g, " ")));

// Vim multi-line editing: yank/paste a line, visual-block delete.
await page.click("#r-again");
await page.click("#typed .cm-content");
await page.keyboard.press("Escape");
await page.keyboard.type("iabc");
await page.keyboard.press("Escape");
await page.keyboard.type("yyp");
await page.keyboard.press("Control+v");
await page.keyboard.type("kd");
const doc = await page.evaluate(() => window.codetype.typedView.state.doc.toString());
assert(doc === "bc\nbc", `vim yy p + Ctrl-v block delete works (got ${JSON.stringify(doc)})`);

assert(errors.length === 0, "no page errors " + errors.join("; "));
await page.screenshot({ path: process.env.SHOT || "test/screenshot.png" });
await browser.close();
