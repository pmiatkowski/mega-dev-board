// Records the deployed board in use (step-1 evidence).
//   node scripts/record.mjs <boardUrl> <outVideoPath>
//
// One take, all three plan flows:
//   open-board    — page opens, loader clears, tonight's incidents listed
//   watch-board   — board stays open; a NEW incident lands at the top with no reload
//   ack-incident  — the new incident is acked; the mark survives further refreshes
// Timeline (ms from video start) and the ack receipt land next to the video as
// <outVideoPath>.timeline.json.
import { chromium } from 'playwright';
import { renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, outPath] = process.argv.slice(2);
if (!url || !outPath) {
  console.error('usage: node scripts/record.mjs <boardUrl> <outVideoPath>');
  process.exit(1);
}

const startedAt = new Date();
const t0 = Date.now();
const timeline = [];
const note = (event, detail = '') => {
  const ms = Date.now() - t0;
  timeline.push({ ms, event, detail });
  console.log(`${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} ${event} ${detail}`);
};

const consoleLines = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: dirname(outPath), size: { width: 1280, height: 720 } },
  locale: 'en-GB', // EU on-call: day before month (dd/mm)
  timezoneId: 'Europe/Berlin',
});
const page = await ctx.newPage();
page.on('console', (m) => consoleLines.push(m.text()));

await page.goto(url, { waitUntil: 'domcontentloaded' });
note('open-board: page opened');

await page.getByTestId('loader').waitFor({ state: 'detached', timeout: 15000 });
note('open-board: loader gone, incidents on screen');

const firstRows = await page.getByTestId('incident-row').count();
const firstId = await page.getByTestId('incident-row').first().getAttribute('data-id');
note('open-board: rows listed', `${firstRows} rows, top ${firstId}`);
const footerSha = (await page.getByTestId('build-sha').innerText()).trim();
note('build-sha in footer', footerSha);

// watch-board: wait (up to 9 min) for a new incident at the top, no reload.
// A person reacts at once: scan the top row a few times a second and click the
// moment the new one lands — no waiting for the page to settle.
let navCount = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navCount++; });

const deadline = Date.now() + 9 * 60 * 1000;
let newId = null;
let lastMotion = 0;
while (Date.now() < deadline) {
  const topId = await page.getByTestId('incident-row').first().getAttribute('data-id');
  if (topId !== firstId) { newId = topId; break; }
  if (Date.now() - lastMotion > 4000) { // idle hand drift, never delays the click
    await page.mouse.move(500 + Math.random() * 300, 300 + Math.random() * 120);
    lastMotion = Date.now();
  }
  await page.waitForTimeout(250);
}
if (newId) {
  note('watch-board: new incident at top, no reload', `${newId} (navigations so far: ${navCount})`);
} else {
  note('watch-board: no new incident within 9 min', `navigations so far: ${navCount}`);
}

// ack-incident: the row that just landed — click it right away, mid-change.
const ackId = newId ?? firstId;
const row = page.locator(`[data-testid="incident-row"][data-id="${ackId}"]`);
const ackBtn = row.getByTestId('ack');
await ackBtn.hover({ timeout: 5000 }); // the hand moves to the button
await ackBtn.click({ timeout: 5000 }); // and takes it while the board still refreshes
await row.getByTestId('acked').waitFor({ timeout: 15000 });
note('ack-incident: acked', ackId);

// the mark must survive further 2 s refreshes
await page.waitForTimeout(8000);
const still = await page.locator(`[data-testid="incident-row"][data-id="${ackId}"] [data-testid="acked"]`).count();
note('ack-incident: acked mark still there after refreshes', still === 1 ? 'yes' : 'NO');
note('watch-board: navigations total (must be 0)', String(navCount));

await ctx.close(); // closes the video file
await browser.close();

// playwright names the video after the page object; find the newest webm and rename
const dir = dirname(outPath);
const newest = readdirSync(dir)
  .filter((f) => f.endsWith('.webm'))
  .map((f) => ({ f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];
renameSync(`${dir}/${newest.f}`, outPath);

const ackLine = consoleLines.find((l) => l.startsWith('ack '));
// server-side view of the race: how close was the ack to the incident's landing?
let landedGapMs = null;
let openedAtServer = null;
try {
  const { API, SESSION } = await import('../app/config.js');
  const res = await fetch(`${API}/incidents?t=${SESSION}`);
  const pageNow = await res.json();
  const hit = pageNow.incidents.find((i) => i.id === ackId);
  if (hit && ackLine) {
    openedAtServer = hit.openedAt;
    landedGapMs = new Date(ackLine.split(' ')[2]).getTime() - new Date(hit.openedAt).getTime();
  }
} catch (e) {
  console.warn('could not fetch server view of the landing:', e.message);
}
const result = {
  url,
  startedAt: startedAt.toISOString(),
  footerSha,
  ackId,
  ackConsoleLine: ackLine ?? null,
  openedAtServer,
  landedGapMs,
  navCount,
  timeline,
};
writeFileSync(`${outPath}.timeline.json`, JSON.stringify(result, null, 2));
console.log(`\nvideo: ${outPath}`);
console.log(`timeline: ${outPath}.timeline.json`);
console.log(`ack console line: ${ackLine}`);
