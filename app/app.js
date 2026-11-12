import { fetchIncidents, ack } from './api.js';

// SCHED-4513 — refresh cadence (R4): every 2 seconds while the board is open.
const REFRESH_MS = 2000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');

// SCHED-4511 — acked incidents stay acked across refreshes (R2).
const ackedIds = new Set();

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// SCHED-4514 — the viewer's local time (R5). Intl follows the viewer's locale,
// so EU locales get day before month (dd/mm) and others their own order.
// The full UTC value stays in the <time datetime> attribute.
function localTime(iso) {
  const d = new Date(iso);
  const locale = navigator.languages?.[0] || navigator.language || undefined;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function ackPart(id) {
  if (ackedIds.has(id)) {
    return '<span data-testid="acked" class="acked">acked</span>';
  }
  return `<button data-testid="ack" class="ack" type="button" data-id="${esc(id)}">Ack</button>`;
}

function rowHtml(i) {
  return `<li data-testid="incident-row" data-id="${esc(i.id)}" class="row ${esc(i.severity)}">
        <span class="id">${esc(i.id)}</span>
        <span class="sev">${esc(i.severity)}</span>
        <span class="what">${esc(i.service)} · ${esc(i.region)} · ${esc(i.summary)}</span>
        <time datetime="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time>
        ${ackPart(i.id)}
      </li>`;
}

// R1 — the API answers newest first; new incidents land at the top on refresh.
function render(incidents) {
  list.innerHTML = incidents.map(rowHtml).join('');
  empty.hidden = incidents.length > 0;
}

let loaded = false;
let refreshing = false;

// SCHED-4513 — one poll at a time, so a slow answer cannot stack requests (R4).
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const page = await fetchIncidents();
    if (!loaded) {
      loaded = true;
      loader.remove(); // SCHED-4512 — loader gone once incidents load (R3)
      list.hidden = false;
    }
    render(page.incidents);
  } catch (err) {
    if (!loaded) throw err;
    console.warn('refresh failed; keeping the last list', err);
  } finally {
    refreshing = false;
  }
}

// SCHED-4511 — Ack per row: api.ack(id), then the row is marked acked (R2).
board.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-testid="ack"]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  try {
    const reply = await ack(id);
    ackedIds.add(reply.id);
    const row = list.querySelector(`[data-testid="incident-row"][data-id="${CSS.escape(reply.id)}"]`);
    if (row) {
      const mark = document.createElement('span');
      mark.dataset.testid = 'acked';
      mark.className = 'acked';
      mark.textContent = 'acked';
      btn.replaceWith(mark);
    }
  } catch (err) {
    btn.disabled = false;
    console.error('ack failed', id, err);
  }
});

await refresh();
setInterval(refresh, REFRESH_MS);
