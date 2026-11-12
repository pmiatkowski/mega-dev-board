import { fetchIncidents, ack } from './api.js';

// SCHED-4513 — refresh cadence (R4): every 2 seconds while the board is open.
const REFRESH_MS = 2000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const panel = document.querySelector('[data-testid="incident-panel"]');

// SCHED-4511 — acked incidents stay acked across refreshes (R2).
const ackedIds = new Set();

// Product, 2026-11-12: Ack leaves the row. A row opens its incident panel;
// the panel names the incident it holds, and Ack lives there. The ack always
// names the incident on-call is looking at, even when the list shifts.
let openId = null;
let openSnapshot = null;

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

function rowHtml(i) {
  const mark = ackedIds.has(i.id)
    ? '<span data-testid="acked" class="acked">acked</span>'
    : '<span class="ackslot"></span>';
  const opened = openId === i.id ? ' opened' : '';
  return `<li data-testid="incident-row" data-id="${esc(i.id)}" class="row ${esc(i.severity)}${opened}" title="open incident panel">
        <span class="id">${esc(i.id)}</span>
        <span class="sev">${esc(i.severity)}</span>
        <span class="what">${esc(i.service)} · ${esc(i.region)} · ${esc(i.summary)}</span>
        <time datetime="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time>
        ${mark}
      </li>`;
}

// R1 — the API answers newest first; new incidents land at the top on refresh.
function render(incidents) {
  list.innerHTML = incidents.map(rowHtml).join('');
  empty.hidden = incidents.length > 0;
}

let lastPanelKey = null;
function renderPanel() {
  if (!openSnapshot) {
    panel.hidden = true;
    panel.dataset.id = '';
    lastPanelKey = null;
    return;
  }
  const i = openSnapshot;
  const acked = ackedIds.has(i.id);
  // Rebuild the panel only when what it says changed; the Ack button then
  // stays the same node across the 2-second refreshes.
  const key = JSON.stringify([i, acked]);
  if (panel.hidden || key !== lastPanelKey) {
    lastPanelKey = key;
    panel.hidden = false;
    panel.dataset.id = i.id;
    panel.innerHTML = `
      <button type="button" class="panel-close" title="close panel">✕</button>
      <h2 class="panel-id">${esc(i.id)}</h2>
      <p class="panel-sev ${esc(i.severity)}">${esc(i.severity)}</p>
      <dl class="panel-facts">
        <dt>service</dt><dd>${esc(i.service)}</dd>
        <dt>region</dt><dd>${esc(i.region)}</dd>
        <dt>opened</dt><dd><time datetime="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time></dd>
        <dt>summary</dt><dd>${esc(i.summary)}</dd>
      </dl>
      ${acked
        ? '<span data-testid="acked" class="acked">acked</span>'
        : '<button type="button" data-testid="panel-ack" class="ack">Ack</button>'}`;
  }
}

let loaded = false;
let refreshing = false;
let lastIncidents = [];

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
    lastIncidents = page.incidents;
    render(lastIncidents);
    const fresh = lastIncidents.find((i) => i.id === openId);
    if (fresh) openSnapshot = fresh; // the open panel keeps naming its incident
    renderPanel();
  } catch (err) {
    if (!loaded) throw err;
    console.warn('refresh failed; keeping the last list', err);
  } finally {
    refreshing = false;
  }
}

// A row opens its incident panel; the same row again closes it (product, 2026-11-12).
list.addEventListener('click', (e) => {
  const row = e.target.closest('[data-testid="incident-row"]');
  if (!row) return;
  const id = row.dataset.id;
  openId = openId === id ? null : id;
  openSnapshot = openId ? (lastIncidents.find((i) => i.id === openId) ?? openSnapshot) : null;
  render(lastIncidents); // re-marks the opened row
  renderPanel();
});

// Ack lives in the panel (product, 2026-11-12): api.ack(id) for the incident
// the panel names, then the mark lands in panel and row (R2).
panel.addEventListener('click', async (e) => {
  if (e.target.closest('.panel-close')) {
    openId = null;
    openSnapshot = null;
    renderPanel();
    for (const row of list.querySelectorAll('.opened')) row.classList.remove('opened');
    return;
  }
  const btn = e.target.closest('[data-testid="panel-ack"]');
  if (!btn || btn.disabled) return;
  const id = panel.dataset.id;
  btn.disabled = true;
  try {
    const reply = await ack(id);
    ackedIds.add(reply.id);
    renderPanel(); // panel now shows the acked mark
    const row = list.querySelector(`[data-testid="incident-row"][data-id="${CSS.escape(reply.id)}"]`);
    if (row) {
      const slot = row.querySelector('.ackslot');
      if (slot) {
        const mark = document.createElement('span');
        mark.dataset.testid = 'acked';
        mark.className = 'acked';
        mark.textContent = 'acked';
        slot.replaceWith(mark);
      }
    }
  } catch (err) {
    btn.disabled = false;
    console.error('ack failed', id, err);
  }
});

await refresh();
setInterval(refresh, REFRESH_MS);
