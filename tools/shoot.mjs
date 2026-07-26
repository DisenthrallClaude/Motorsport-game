// Headless screenshot harness used for the visual QA rounds.
//   node tools/shoot.mjs <outfile> [urlQuery] [waitMs] [w] [h]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'shot.png';
const query = process.argv[3] || '';
const waitMs = Number(process.argv[4] || 9000);
const W = Number(process.argv[5] || 1600);
const H = Number(process.argv[6] || 900);
const PORT = process.env.SHOT_PORT || '4173';

fs.mkdirSync(path.dirname(out) || '.', { recursive: true });

const browser = await chromium.launch({
  // The pinned browser in this image is a different revision to the npm
  // package default, so point Playwright straight at it.
  executablePath: '/opt/pw-browsers/chromium',
  // This Chromium dropped `--headless=old`, which is what Playwright passes
  // when `headless: true`. Drive the new headless mode by hand instead.
  headless: false,
  args: [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

const url = `http://127.0.0.1:${PORT}/${query}`;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  logs.push(`[goto] ${e.message}`);
}

await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
console.log(`saved ${out}`);
console.log('──── console ────');
console.log(logs.slice(0, 80).join('\n') || '(clean)');

// Report anything the page chose to publish for the harness.
try {
  const diag = await page.evaluate(() => (window.__diag ? window.__diag() : null));
  if (diag) console.log('──── diag ────\n' + JSON.stringify(diag, null, 2));
} catch { /* page may not expose diagnostics yet */ }

await browser.close();
