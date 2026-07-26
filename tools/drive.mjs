// Drive test: holds throttle and steers, then reports the sim state.
import { chromium } from 'playwright';

const PORT = process.env.SHOT_PORT || '4173';
const query = process.argv[2] || '?city=london&auto=1&q=low&rivals=3';
const seconds = Number(process.argv[3] || 40);
const out = process.argv[4];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: false,
  args: ['--headless=new', '--hide-scrollbars', '--mute-audio', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(30000);          // world build + countdown

const samples = [];
await page.keyboard.down('KeyW');
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1000);
  if (i % 7 === 3) { await page.keyboard.down('KeyD'); }
  if (i % 7 === 5) { await page.keyboard.up('KeyD'); await page.keyboard.down('KeyA'); }
  if (i % 7 === 6) { await page.keyboard.up('KeyA'); }
  const d = await page.evaluate(() => {
    const g = window.__game;
    if (!g || !g.player) return null;
    return {
      t: +g.raceTime.toFixed(1), state: g.state,
      mph: +g.player.physics.speedMph.toFixed(0),
      gear: g.player.physics.gear,
      lap: g.player.lap, pos: g.player.position,
      s: Math.round(g.player.trackS), lat: +g.player.lateral.toFixed(1),
      onTrack: Math.abs(g.player.lateral) < 9,
      aiLead: Math.round(Math.max(...g.cars.map((c) => c.totalProgress))),
      fps: +g.engine.fps.toFixed(1),
    };
  });
  if (d) samples.push(d);
}
await page.keyboard.up('KeyW');
if (out) await page.screenshot({ path: out });

console.log(JSON.stringify({
  errors: errs.slice(0, 10),
  first: samples[0], mid: samples[Math.floor(samples.length / 2)], last: samples[samples.length - 1],
  maxMph: Math.max(...samples.map((s) => s.mph)),
  gearsUsed: [...new Set(samples.map((s) => s.gear))].sort(),
  lapsSeen: [...new Set(samples.map((s) => s.lap))],
  posSeen: [...new Set(samples.map((s) => s.pos))],
  offTrackSamples: samples.filter((s) => !s.onTrack).length,
  states: [...new Set(samples.map((s) => s.state))],
}, null, 2));
await browser.close();
