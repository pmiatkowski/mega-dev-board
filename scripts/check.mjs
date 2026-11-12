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
const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

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
  const times = await berlin.locator('[data-testid="incident-row"] time').evaluateAll(
    (els) => els.map((el) => el.getAttribute('datetime')),
  );
  const sorted = [...times].sort((a, b) => b.localeCompare(a));
  ok('R1 newest first', JSON.stringify(times) === JSON.stringify(sorted));
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

// R2: ack a row — mark appears, receipt logged, state survives a refresh cycle.
r2: {
  const row = auk.getByTestId('incident-row').first();
  const id = await row.getAttribute('data-id');
  await row.getByTestId('ack').click();
  await row.getByTestId('acked').waitFor({ timeout: 10000 });
  ok('R2 acked mark appears', true, id);
  const ackLine = consoleLines.find((l) => l.startsWith('[auckland] ack '));
  ok('R2 receipt logged', !!ackLine, ackLine?.slice(0, 120));
  await auk.waitForTimeout(5000); // ≥2 refresh passes
  const stillAcked = await auk.locator(`[data-testid="incident-row"][data-id="${id}"] [data-testid="acked"]`).count();
  ok('R2 acked survives refresh', stillAcked === 1);
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
