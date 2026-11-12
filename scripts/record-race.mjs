// Records the ack race (step-1 evidence): a person aims at a row's Ack button,
// and while their hand moves, the 2-second re-render lands a new incident on
// top and shifts the list — the click hits the row that slid into the aimed
// spot. Evidence: the row meant (expected) vs the row the receipt names (got).
//   node scripts/record-race.mjs <boardUrl> <outVideoPath>
import { chromium } from 'playwright';
import { renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, outPath] = process.argv.slice(2);
if (!url || !outPath) {
  console.error('usage: node scripts/record-race.mjs <boardUrl> <outVideoPath>');
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

await page.goto(url, { waitUntil: 'domcontentloaded' });
note('open-board: page opened');
await page.getByTestId('loader').waitFor({ state: 'detached', timeout: 15000 });
const rows0 = await page.getByTestId('incident-row').count();
const topId0 = await page.getByTestId('incident-row').first().getAttribute('data-id');
note('open-board: loader gone, incidents on screen', `${rows0} rows, top ${topId0}`);
const footerSha = (await page.getByTestId('build-sha').innerText()).trim();
note('build-sha in footer', footerSha);

// The row a person reads and goes for: the second row (index 1).
const TARGET_INDEX = 1;
const idAt = (i) => page.getByTestId('incident-row').nth(i).getAttribute('data-id');
const expected = await idAt(TARGET_INDEX);
const btn = page.getByTestId('incident-row').nth(TARGET_INDEX).getByTestId('ack');
const box = await btn.boundingBox();
const aim = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await page.mouse.move(aim.x, aim.y); // the hand is on its way to this button
note('aim: hand moves to the Ack button of', `${expected} at (${aim.x.toFixed(0)}, ${aim.y.toFixed(0)})`);

// Person pauses over the button; the board keeps refreshing around it. The
// moment the row at the aimed position is no longer the one aimed at, the
// finger is already coming down — click at the locked coordinates.
const deadline = Date.now() + 9 * 60 * 1000;
let shifted = false;
while (Date.now() < deadline) {
  const idNow = await idAt(TARGET_INDEX);
  if (idNow !== expected) { shifted = true; break; }
  await page.waitForTimeout(100);
}
note(shifted ? 'shift: the list changed under the pointer —' : 'no shift within 9 min:', shifted ? `row at aimed position is now ${await idAt(TARGET_INDEX)}` : 'ack the aimed row anyway');

await page.mouse.click(aim.x, aim.y); // positional click, like a person
await page.getByTestId('acked').first().waitFor({ timeout: 15000 });
const gotRow = await page.locator('[data-testid="incident-row"] [data-testid="acked"]').evaluate(
  (el) => el.closest('[data-testid="incident-row"]').dataset.id,
);
note('click: acked mark appeared on', gotRow);

// leave the board on screen: the mark sits on a different row than the one aimed at
await page.waitForTimeout(6000);
const aimedStill = await page.locator(`[data-testid="incident-row"][data-id="${expected}"] [data-testid="acked"]`).count();
note('the row aimed at is acked?', aimedStill === 1 ? 'yes' : 'no — the ack went to another row');

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
  expected,
  gotRow,
  raceMisfired: gotRow !== expected,
  ackConsoleLine: ackLine ?? null,
  timeline,
};
writeFileSync(`${outPath}.timeline.json`, JSON.stringify(result, null, 2));
console.log(`\nvideo: ${outPath}`);
console.log(`expected (row meant): ${expected}`);
console.log(`got (row acked):      ${gotRow}  ${result.raceMisfired ? '— RACE MISFIRED' : '— hit the aimed row'}`);
console.log(`ack console line: ${ackLine}`);
