// Records the step-2 proof: the rebuilt board per product's decision —
// a row opens its incident panel, Ack lives there, the panel names the
// incident it holds, and new incidents stay live at the top.
//   node scripts/record-step2.mjs <boardUrl> <outVideoPath>
import { chromium } from 'playwright';
import { renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, outPath] = process.argv.slice(2);
if (!url || !outPath) {
  console.error('usage: node scripts/record-step2.mjs <boardUrl> <outVideoPath>');
  process.exit(1);
}

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
  locale: 'en-GB',
  timezoneId: 'Europe/Berlin',
});
const page = await ctx.newPage();
page.on('console', (m) => consoleLines.push(m.text()));
let navCount = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navCount++; });

await page.goto(url, { waitUntil: 'domcontentloaded' });
note('open-board: page opened');
await page.getByTestId('loader').waitFor({ state: 'detached', timeout: 15000 });
const rows0 = await page.getByTestId('incident-row').count();
note('open-board: loader gone, incidents on screen', `${rows0} rows`);
const footerSha = (await page.getByTestId('build-sha').innerText()).trim();
note('build-sha in footer', footerSha);

// watch-board: a new incident lands at the top, live, no reload.
const firstId = await page.getByTestId('incident-row').first().getAttribute('data-id');
const deadline = Date.now() + 9 * 60 * 1000;
let newId = null;
let lastMotion = 0;
while (Date.now() < deadline) {
  const topId = await page.getByTestId('incident-row').first().getAttribute('data-id');
  if (topId !== firstId) { newId = topId; break; }
  if (Date.now() - lastMotion > 4000) {
    await page.mouse.move(500 + Math.random() * 300, 300 + Math.random() * 120);
    lastMotion = Date.now();
  }
  await page.waitForTimeout(250);
}
note(newId ? 'watch-board: new incident at top, no reload' : 'watch-board: no new incident within 9 min',
  `${newId ?? firstId} (navigations: ${navCount})`);

// ack-incident, new shape: the row opens its panel; Ack lives there.
const targetId = newId ?? firstId;
const row = page.locator(`[data-testid="incident-row"][data-id="${targetId}"]`);
await row.click();
const panel = page.getByTestId('incident-panel');
await panel.waitFor({ state: 'visible', timeout: 5000 });
note('panel opens, names the incident', `${await panel.getAttribute('data-id')} — shown as ${(await panel.innerText()).split('\n')[0]}`);

await panel.getByTestId('panel-ack').click();
await panel.getByTestId('acked').waitFor({ timeout: 15000 });
note('ack-incident: panel acks it', targetId);

// the mark lands in the row too, and both survive further refreshes;
// the panel keeps naming its incident while the list keeps moving.
await page.waitForTimeout(8000);
const rowAcked = await page.locator(`[data-testid="incident-row"][data-id="${targetId}"] [data-testid="acked"]`).count();
const panelNames = await panel.getAttribute('data-id');
note('mark in row + panel still names it', `rowAcked=${rowAcked === 1}, panel=${panelNames}`);
note('watch-board: navigations total (must be 0)', String(navCount));

await ctx.close();
await browser.close();

const dir = dirname(outPath);
const newest = readdirSync(dir)
  .filter((f) => f.endsWith('.webm'))
  .map((f) => ({ f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];
renameSync(`${dir}/${newest.f}`, outPath);

const ackLine = consoleLines.find((l) => l.startsWith('ack '));
const result = {
  url,
  startedAt: new Date().toISOString(),
  footerSha,
  targetId,
  ackConsoleLine: ackLine ?? null,
  navCount,
  timeline,
};
writeFileSync(`${outPath}.timeline.json`, JSON.stringify(result, null, 2));
console.log(`\nvideo: ${outPath}`);
console.log(`ack console line: ${ackLine}`);
