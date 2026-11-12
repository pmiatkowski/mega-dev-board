// Local check of the plan's requirements against the real API.
//   node scripts/check.mjs [baseUrl]     (default http://127.0.0.1:3210)
// Drives the stamped build with chromium: loader lifecycle (R3), rows (R1),
// 2 s refresh with no reload (R4), local times in Berlin + Auckland (R5),
// ack flow with receipt (R2), build sha in meta + footer (R6).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = process.argv[2] ?? 'http://127.0.0.1:3210';
// same rule the deploy stamps: the last commit that changed the shipped app
const sha = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', 'app/'], { encoding: 'utf8' }).trim();

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const consoleLines = [];

async function openAs(tag, locale, timezone) {
  const ctx = await browser.newContext({ locale, timezoneId: timezone });
  const page = await ctx.newPage();
  page.on('console', (m) => consoleLines.push(`[${tag}] ${m.text()}`));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

// R3 + R1: loader first, then gone; rows newest first.
const { ctx: berlinCtx, page: berlin } = await openAs('berlin', 'de-DE', 'Europe/Berlin');
t0: {
  const loader = berlin.getByTestId('loader');
  await loader.waitFor({ state: 'visible', timeout: 3000 }).then(
    () => ok('R3 loader shows on open', true),
    () => ok('R3 loader shows on open', false, 'never visible (load too fast to catch is still a fail to observe)'),
  );
  await berlin.getByTestId('loader').waitFor({ state: 'detached', timeout: 10000 });
  ok('R3 loader gone after load', true);
  await berlin.getByTestId('incident-row').first().waitFor({ timeout: 10000 });
  const rows = await berlin.getByTestId('incident-row').count();
  ok('R1 rows render', rows > 0, `${rows} rows`);
  const times = await berlin.locator('[data-testid="incident-row"]').evaluateAll(
    (els) => els.map((el) => el.dataset.ts),
  );
  const sorted = [...times].map(Number).sort((a, b) => b - a).map(String);
  ok('R1 newest first', JSON.stringify(times) === JSON.stringify(sorted));
}

// DOM stability (course check j): rows are never removed or moved — new deals
// are inserted in place, refreshes only add.
domStability: {
  await berlin.evaluate(() => {
    window.__rowsRemoved = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) {
        if (n.nodeType === 1 && (n.matches?.('[data-testid="incident-row"]') || n.querySelector?.('[data-testid="incident-row"]'))) {
          window.__rowsRemoved += n.matches?.('[data-testid="incident-row"]') ? 1 : n.querySelectorAll('[data-testid="incident-row"]').length;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const before = await berlin.getByTestId('incident-row').count();
  await berlin.waitForTimeout(9000); // ≥4 refresh passes
  const removed = await berlin.evaluate(() => window.__rowsRemoved);
  const after = await berlin.getByTestId('incident-row').count();
  ok('R4/j no rows removed across refreshes', removed === 0, `${removed} removals; rows ${before}→${after}`);
  ok('R4/j row count never drops', after >= before, `${before}→${after}`);
}

// R5: Berlin sees local time, day before month; UTC kept in datetime.
r5berlin: {
  const row = berlin.getByTestId('incident-row').first();
  const dt = await row.locator('time').getAttribute('datetime');
  const text = await row.locator('time').innerText();
  const m = text.match(/^(\d{1,2})[./-](\d{1,2})[./-]?,? (\d{1,2}):(\d{2})/);
  ok('R5 Berlin local time shape day.month hh:mm', !!m, JSON.stringify(text));
  // exact check: rendered text must equal Intl in the page's own zone/locale
  const expect = await berlin.evaluate(
    (iso) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
    dt,
  );
  ok('R5 Berlin text matches Intl de-DE', text.trim() === expect, `${text.trim()} == ${expect}`);
  ok('R5 datetime keeps UTC', dt.endsWith('Z'), dt);
}

// R5: Auckland viewer — own zone, own order.
const { ctx: aukCtx, page: auk } = await openAs('auckland', 'en-NZ', 'Pacific/Auckland');
r5auckland: {
  const id = await berlin.getByTestId('incident-row').first().getAttribute('data-id');
  const row = auk.locator(`[data-testid="incident-row"][data-id="${id}"]`);
  await row.waitFor({ timeout: 5000 });
  const dt = await row.locator('time').getAttribute('datetime');
  const text = (await row.locator('time').innerText()).trim();
  const expect = await auk.evaluate(
    (iso) => new Intl.DateTimeFormat('en-NZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
    dt,
  );
  ok('R5 Auckland text matches Intl en-NZ', text === expect, `${text} == ${expect}`);
  // day-first in both hemispheres
  ok('R5 day before month in both', /^\d{1,2}[./]/.test(text) && true, text);
  // cross-check: same incident, different hemispheres → different rendered times
  const berlinText = (await berlin.locator(`[data-testid="incident-row"][data-id="${id}"] time`).innerText()).trim();
  ok('R5 Berlin and Auckland differ', text !== berlinText, `berlin ${berlinText} vs auckland ${text}`);
}

// R4: polling every 2 s, page never reloads.
r4: {
  const requests = [];
  auk.on('request', (r) => { if (r.url().includes('/incidents')) requests.push(r.url()); });
  const navs = [];
  auk.on('framenavigated', (f) => { if (f === auk.mainFrame()) navs.push(f.url()); });
  await auk.waitForTimeout(6500);
  ok('R4 polls /incidents ≥3 in 6.5 s', requests.length >= 3, `${requests.length} polls`);
  ok('R4 no reload', navs.length === 0, `${navs.length} navigations`);
}

// R2 (product 2026-11-12): row opens the panel; Ack lives in the panel.
r2: {
  const row = auk.getByTestId('incident-row').first();
  const id = await row.getAttribute('data-id');
  const rowAckButtons = await auk.getByTestId('ack').count();
  ok('R2 rows carry no Ack button', rowAckButtons === 0, `${rowAckButtons} found`);

  await row.click();
  const panel = auk.getByTestId('incident-panel');
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  ok('R2 row opens panel', true);
  ok('R2 panel names the incident', (await panel.getAttribute('data-id')) === id
    && (await panel.innerText()).includes(id), `data-id=${await panel.getAttribute('data-id')}`);

  await panel.getByTestId('panel-ack').click();
  await panel.getByTestId('acked').waitFor({ timeout: 10000 });
  ok('R2 panel acks and marks', true, id);
  const ackLine = consoleLines.find((l) => l.startsWith('[auckland] ack '));
  ok('R2 receipt logged', !!ackLine, ackLine?.slice(0, 120));

  await auk.waitForTimeout(5000); // ≥2 refresh passes
  const rowAcked = await auk.locator(`[data-testid="incident-row"][data-id="${id}"] [data-testid="acked"]`).count();
  ok('R2 acked survives refresh in row', rowAcked >= 1, `${rowAcked} marked rows`);
  const panelStillNames = await panel.getAttribute('data-id');
  const panelAcked = await panel.getByTestId('acked').count();
  ok('R2 panel keeps naming it + stays acked', panelStillNames === id && panelAcked === 1);

  // toggle: clicking the same row closes the panel
  await auk.locator(`[data-testid="incident-row"][data-id="${id}"]`).click();
  ok('R2 same row closes panel', await panel.isHidden());
}

// R6: build sha in meta + footer.
r6: {
  const meta = await auk.locator('meta[name="build"]').getAttribute('content');
  const footer = (await auk.getByTestId('build-sha').innerText()).trim();
  ok('R6 meta build = git sha', meta === sha, meta);
  ok('R6 footer sha = git sha', footer === sha, footer);
}

await berlinCtx.close();
await aukCtx.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nconsole lines captured:');
  for (const l of consoleLines) console.log(l);
  process.exit(1);
}
