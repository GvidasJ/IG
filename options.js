// options.js — the dashboard. A thin view over stored state plus local
// generation: all queue decisions live in the background worker, all
// Instagram knowledge lives in detector.js. Nothing here talks to the network.

'use strict';

const $ = (id) => document.getElementById(id);

// ---- view state (not persisted) ---------------------------------------
let filter = 'ALL';
let sortKey = 'checkedAt';
let sortDir = -1; // newest first
const selected = new Set();
let lastState = null; // latest HH_GET_STATE payload

// =======================================================================
// Generator panel
// =======================================================================

const GEN_TYPES = [
  { id: 'phonetic-cvcv', label: 'Phonetic CVCV (zeva, kito)' },
  { id: 'phonetic-cvc', label: 'Phonetic CVC (nim, sab)' },
  { id: 'phonetic-cvcc', label: 'Phonetic CVCC (narv, volt)' },
  { id: 'phonetic-cvcvc', label: 'Phonetic CVCVC (5 letters)' },
  { id: 'wordaffix', label: 'Real word + affix (wolfhq, driftly)' },
  { id: 'portmanteau', label: 'Portmanteau (two words you supply)' },
  { id: 'doubled', label: 'Doubled letters (mattt, hooop)' },
  { id: 'novowel', label: 'No-vowel cluster (krsh, blvd)' },
  { id: 'swaps', label: 'Swaps of a base handle (dots/underscores/leet)' },
  { id: 'sweep', label: '⚠ Brute-force sweep (gated)' },
];

function buildGeneratorPanel() {
  const c = $('generator-controls');
  c.innerHTML = `
    <label>Pattern</label>
    <select id="gen-type">${GEN_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</select>
    <div id="gen-params"></div>
    <div class="row" style="margin-top:8px">
      <button id="gen-go" class="primary">Generate → list</button>
    </div>
    <div id="gen-feedback" class="small dim"></div>
  `;
  $('gen-type').addEventListener('change', buildGenParams);
  $('gen-go').addEventListener('click', generate);
  buildGenParams();
}

function buildGenParams() {
  const type = $('gen-type').value;
  const p = $('gen-params');
  const count = `<label>How many</label><input type="number" id="gen-count" value="50" min="1" max="500">`;
  if (type.startsWith('phonetic-')) {
    p.innerHTML = count;
  } else if (type === 'wordaffix') {
    p.innerHTML = `
      <label>Word length</label>
      <div class="row">
        <input type="number" id="gen-minlen" value="3" min="2" max="8" title="min">
        <input type="number" id="gen-maxlen" value="6" min="3" max="8" title="max">
      </div>
      <label>Must contain (optional word)</label>
      <input type="text" id="gen-contains" class="handle" placeholder="wolf">
      ${count}`;
  } else if (type === 'portmanteau') {
    p.innerHTML = `
      <label>Word A</label><input type="text" id="gen-worda" class="handle" placeholder="breakfast">
      <label>Word B</label><input type="text" id="gen-wordb" class="handle" placeholder="lunch">`;
  } else if (type === 'doubled') {
    p.innerHTML = `
      <label>Base (blank = random words)</label>
      <input type="text" id="gen-base" class="handle" placeholder="matt">
      ${count}`;
  } else if (type === 'novowel') {
    p.innerHTML = `<label>Length</label><input type="number" id="gen-length" value="4" min="3" max="6">${count}`;
  } else if (type === 'swaps') {
    p.innerHTML = `<label>Base handle you want</label><input type="text" id="gen-base" class="handle" placeholder="zeva">`;
  } else if (type === 'sweep') {
    p.innerHTML = `
      <label>Alphabet</label>
      <select id="gen-alpha"><option value="letters">a–z</option><option value="alnum">a–z + 0–9</option></select>
      <label>Length</label><input type="number" id="gen-length" value="4" min="1" max="6">
      <label>Fixed prefix (optional — shrinks the sweep)</label>
      <input type="text" id="gen-prefix" class="handle" placeholder="ze">
      <label>Start offset (continue a previous sweep)</label>
      <input type="number" id="gen-offset" value="0" min="0">
      <div id="sweep-estimate" class="small"></div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:6px">
        <input type="checkbox" id="sweep-ack" style="width:auto">
        I've read the time estimate and still want this
      </label>`;
    const upd = updateSweepEstimate;
    for (const idd of ['gen-alpha', 'gen-length', 'gen-prefix']) $(idd).addEventListener('input', upd);
    upd();
  }
}

function fmtDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86400).toFixed(1)} DAYS`;
}

function secPerCheck() {
  const s = lastState ? lastState.settings : HHStorage.DEFAULTS.settings;
  return s.rateSeconds * (1 + s.jitterFrac / 2);
}

function updateSweepEstimate() {
  const total = HHGenerator.sweepTotal({
    alphabet: $('gen-alpha').value,
    length: Number($('gen-length').value) || 4,
    prefix: $('gen-prefix').value,
  });
  const secs = total * secPerCheck();
  const cap = lastState ? lastState.settings.maxQueue : 500;
  $('sweep-estimate').innerHTML =
    `<b>${total.toLocaleString()} candidates ≈ ${fmtDuration(secs)}</b> of continuous checking ` +
    `at the current safe rate. Only the first ${cap} fit in one run — use the offset to continue later.`;
  $('sweep-estimate').style.color = secs > 6 * 3600 ? 'var(--amber)' : 'var(--text-dim)';
}

function generate() {
  const type = $('gen-type').value;
  const cnt = () => Math.min(Math.max(Number(($('gen-count') || {}).value) || 50, 1), 500);
  let list = [];
  if (type === 'phonetic-cvcv') list = HHGenerator.phonetic({ pattern: 'cvcv', count: cnt() });
  else if (type === 'phonetic-cvc') list = HHGenerator.phonetic({ pattern: 'cvc', count: cnt() });
  else if (type === 'phonetic-cvcc') list = HHGenerator.phonetic({ pattern: 'cvC', count: cnt() });
  else if (type === 'phonetic-cvcvc') list = HHGenerator.phonetic({ pattern: 'cvcvc', count: cnt() });
  else if (type === 'wordaffix') {
    list = HHGenerator.wordAffix({
      minLen: Number($('gen-minlen').value) || 3,
      maxLen: Number($('gen-maxlen').value) || 6,
      mustContain: $('gen-contains').value.trim(),
      count: cnt(),
    });
  } else if (type === 'portmanteau') {
    list = HHGenerator.portmanteau({ wordA: $('gen-worda').value, wordB: $('gen-wordb').value });
    if (!list.length) { $('gen-feedback').textContent = 'Need two words of 2+ letters.'; return; }
  } else if (type === 'doubled') {
    list = HHGenerator.doubled({ base: $('gen-base').value.trim(), count: cnt() });
  } else if (type === 'novowel') {
    list = HHGenerator.novowel({ length: Number($('gen-length').value) || 4, count: cnt() });
  } else if (type === 'swaps') {
    list = HHGenerator.swaps({ base: $('gen-base').value.trim() });
    if (!list.length) { $('gen-feedback').textContent = 'Type a base handle (2+ chars).'; return; }
  } else if (type === 'sweep') {
    if (!$('sweep-ack').checked) {
      $('gen-feedback').textContent = 'Tick the acknowledgement first — read the time estimate.';
      return;
    }
    const cap = lastState ? lastState.settings.maxQueue : 500;
    const r = HHGenerator.sweep({
      alphabet: $('gen-alpha').value,
      length: Number($('gen-length').value) || 4,
      prefix: $('gen-prefix').value,
      offset: Number($('gen-offset').value) || 0,
      limit: cap,
    });
    list = r.candidates;
    $('gen-feedback').textContent =
      `${list.length} of ${r.total.toLocaleString()} queued-able now; next offset: ${r.nextOffset}.`;
  }

  const existing = $('paste-input').value.trim();
  $('paste-input').value = (existing ? existing + '\n' : '') + list.join('\n');
  if (type !== 'sweep') $('gen-feedback').textContent = `${list.length} candidates added to the list — review, edit, then “Add to queue”.`;
}

// =======================================================================
// Queue actions
// =======================================================================

async function addToQueue() {
  const raw = $('paste-input').value;
  if (!raw.trim()) return;
  const resp = await chrome.runtime.sendMessage({ type: 'HH_ENQUEUE', handles: raw });
  if (!resp.ok) { $('paste-feedback').textContent = resp.error; return; }
  const s = resp.summary;
  const bits = [`${s.added} queued`];
  if (s.skippedInvalid.length) bits.push(`${s.skippedInvalid.length} invalid`);
  if (s.skippedResolved.length) bits.push(`${s.skippedResolved.length} already resolved`);
  if (s.skippedDupe) bits.push(`${s.skippedDupe} duplicates`);
  if (s.truncated) bits.push(`${s.truncated} over the ${lastState ? lastState.settings.maxQueue : 500} cap`);
  $('paste-feedback').textContent = bits.join(', ');
  if (s.added) $('paste-input').value = '';
  if (s.added) await chrome.runtime.sendMessage({ type: 'HH_START' });
  refresh();
}

async function runSelfTest() {
  // 5 handles that have been famous for a decade+ and 5 fresh random strings.
  // If any of the first five shows anything but TAKEN, or any random string
  // anything but AVAILABLE, detector.js is wrong — verify rows by hand.
  const famous = ['instagram', 'nasa', 'nike', 'natgeo', 'cristiano'];
  const randoms = Array.from({ length: 5 }, () => HHDetector_randomString());
  const resp = await chrome.runtime.sendMessage({
    type: 'HH_ENQUEUE', handles: [...famous, ...randoms], force: true,
  });
  if (resp.ok) {
    await chrome.runtime.sendMessage({ type: 'HH_START' });
    $('gen-feedback').textContent = '';
  }
  refresh();
}

// Local mirror of the canary's random-string recipe (detector.js isn't loaded
// in this page; the recipe is trivial and self-contained).
function HHDetector_randomString() {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'hh';
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += alpha[b % alpha.length];
  return s;
}

async function verifyRow(handle, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  const resp = await chrome.runtime.sendMessage({ type: 'HH_VERIFY_SIGNUP', handle });
  btn.disabled = false;
  btn.textContent = original;
  if (!resp.ok) {
    // Canary failures and blockers are important — show them prominently.
    $('banner').textContent = (resp.canaryFailed ? '🚨 ' : '⚠ ') + resp.error;
    $('banner').className = 'banner ' + (resp.canaryFailed ? 'error' : 'warn');
    return;
  }
  refresh();
}

// =======================================================================
// Status bar + banner
// =======================================================================

function renderStatus(run, settings) {
  const stateEl = $('run-state');
  stateEl.textContent = run.state.replace(/_/g, ' ');
  stateEl.className = 'pill ' + (run.state === 'running' ? 'AVAILABLE'
    : run.state === 'canary_failed' ? 'UNKNOWN'
    : run.state === 'idle' || run.state === 'done' ? 'PENDING' : 'UNKNOWN');

  const total = run.order.length;
  const done = run.order.filter((h) => run.items[h] && run.items[h].state !== 'PENDING').length;
  const pending = total - done;
  $('run-progress').textContent = total ? `${done}/${total} checked` : 'no queue';
  $('run-rate').textContent = `~1 req / ${settings.rateSeconds}s (+jitter)`;
  $('run-eta').textContent =
    run.state === 'running' && pending ? `~${fmtDuration(pending * secPerCheck())} left` : '';
  $('progress-fill').style.width = total ? `${(100 * done) / total}%` : '0';

  const btn = $('pause-resume');
  // canary_failed has no Resume — the run is aborted; Clear queue acknowledges.
  btn.disabled = run.state === 'canary_failed' || (['idle', 'done'].includes(run.state) && !pending);
  btn.textContent = run.state === 'running' ? 'Pause' : 'Resume';

  renderBanner(run);
}

function renderBanner(run) {
  const banner = $('banner');
  if (run.state === 'canary_failed') {
    banner.textContent = '🚨 ' + run.stateReason;
    banner.className = 'banner error';
  } else if (run.state === 'paused_rate_limited' && run.resumeAdvisedAt) {
    const left = Math.max(0, run.resumeAdvisedAt - Date.now());
    const mins = Math.ceil(left / 60000);
    banner.textContent = left > 0
      ? `⏸ Paused — Instagram is rate-limiting. Resume advised in ~${mins} min. (Resuming early risks a longer block.)`
      : '⏸ Paused — rate-limit backoff has elapsed. You can Resume now.';
    banner.className = 'banner warn';
  } else if (run.stateReason && !['idle', 'running', 'done'].includes(run.state)) {
    banner.textContent = '⏸ ' + run.stateReason;
    banner.className = 'banner warn';
  } else {
    banner.className = 'banner hidden';
  }
}

// =======================================================================
// Results table
// =======================================================================

function allRows() {
  if (!lastState) return [];
  const { run, results } = lastState;
  const map = new Map();
  for (const [h, r] of Object.entries(results)) map.set(h, { handle: h, ...r });
  for (const h of run.order) map.set(h, { handle: h, ...run.items[h] });
  return [...map.values()];
}

function visibleRows() {
  let rows = allRows();
  if (filter !== 'ALL') rows = rows.filter((r) => r.state === filter);
  rows.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (sortKey === 'checkedAt') { x = x || 0; y = y || 0; }
    else if (sortKey === 'signup') { x = (a.signup && a.signup.state) || ''; y = (b.signup && b.signup.state) || ''; }
    else { x = String(x || ''); y = String(y || ''); }
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });
  return rows;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} ${d.getMonth() + 1}/${d.getDate()}`;
}

function renderTable() {
  const rows = visibleRows();
  const favs = new Set(lastState ? lastState.favorites : []);
  const body = $('results-body');
  body.innerHTML = '';
  $('results-empty').style.display = rows.length ? 'none' : 'block';

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = 'state-' + r.state;

    const tdSel = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(r.handle);
    cb.addEventListener('change', () => { cb.checked ? selected.add(r.handle) : selected.delete(r.handle); });
    tdSel.appendChild(cb);

    const tdHandle = document.createElement('td');
    tdHandle.className = 'handle-cell';
    tdHandle.textContent = r.handle;

    const tdState = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill ' + r.state;
    pill.textContent = r.state;
    tdState.appendChild(pill);

    // Signup verdict + Verify button. Verifying only makes sense for names
    // with no existing profile (AVAILABLE) or ambiguous ones (UNKNOWN).
    const tdSignup = document.createElement('td');
    if (r.signup && r.signup.state) {
      const sp = document.createElement('span');
      sp.className = 'pill ' + r.signup.state;
      sp.textContent = r.signup.state;
      sp.title = r.signup.reason || '';
      tdSignup.appendChild(sp);
    }
    if (r.state === 'AVAILABLE' || r.state === 'UNKNOWN') {
      const vb = document.createElement('button');
      vb.className = 'rowbtn';
      vb.textContent = r.signup ? 'Re-verify' : 'Verify';
      vb.title = 'ask Instagram’s signup validator (1 request)';
      vb.addEventListener('click', () => verifyRow(r.handle, vb));
      tdSignup.appendChild(vb);
    }

    const tdTime = document.createElement('td');
    tdTime.className = 'small dim';
    tdTime.textContent = fmtTime(r.checkedAt);

    const tdReason = document.createElement('td');
    tdReason.className = 'small dim';
    tdReason.textContent = r.state === 'UNKNOWN' ? (r.reason || '') : '';

    const tdActions = document.createElement('td');
    const star = document.createElement('button');
    star.className = 'rowbtn';
    star.textContent = favs.has(r.handle) ? '★' : '☆';
    star.title = 'favorite';
    star.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'HH_SET_FAVORITE', handle: r.handle, on: !favs.has(r.handle) });
      refresh();
    });
    tdActions.appendChild(star);
    if (r.state === 'UNKNOWN') {
      const re = document.createElement('button');
      re.className = 'rowbtn';
      re.textContent = 'Re-check';
      re.title = 'single retry';
      re.addEventListener('click', async () => {
        const resp = await chrome.runtime.sendMessage({ type: 'HH_RECHECK', handle: r.handle });
        if (!resp.ok) { $('paste-feedback').textContent = resp.error; }
        refresh();
      });
      tdActions.appendChild(re);
    }

    tr.append(tdSel, tdHandle, tdState, tdSignup, tdTime, tdReason, tdActions);
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

// ---- export ------------------------------------------------------------

function exportRows(ext) {
  const rows = selected.size ? visibleRows().filter((r) => selected.has(r.handle)) : visibleRows();
  if (!rows.length) return;
  let content, mime;
  if (ext === 'txt') {
    content = rows.map((r) => r.handle).join('\n') + '\n';
    mime = 'text/plain';
  } else {
    const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    content = 'handle,state,signup,checked_at,reason\n' + rows.map((r) =>
      [esc(r.handle), esc(r.state), esc(r.signup && r.signup.state || ''),
       esc(r.checkedAt ? new Date(r.checkedAt).toISOString() : ''), esc(r.reason || '')].join(',')
    ).join('\n') + '\n';
    mime = 'text/csv';
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `handle-hunter-${new Date().toISOString().slice(0, 10)}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// =======================================================================
// Favorites panel
// =======================================================================

function renderFavorites() {
  const ul = $('favorites-list');
  ul.innerHTML = '';
  const favs = lastState ? lastState.favorites : [];
  if (!favs.length) {
    ul.innerHTML = '<li class="dim small" style="font-family:var(--sans)">Star rows to save them here.</li>';
    return;
  }
  for (const h of favs) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://www.instagram.com/${encodeURIComponent(h)}/`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = h;
    a.style.color = 'var(--accent)';
    const rm = document.createElement('button');
    rm.className = 'rowbtn';
    rm.textContent = '×';
    rm.title = 'remove';
    rm.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'HH_SET_FAVORITE', handle: h, on: false });
      refresh();
    });
    li.append(a, rm);
    ul.appendChild(li);
  }
}

// =======================================================================
// Settings panel
// =======================================================================

function buildSettingsPanel() {
  const c = $('settings-controls');
  c.innerHTML = `
    <label>Seconds between requests (default 4)</label>
    <input type="number" id="set-rate" min="1" max="3600" step="0.5">
    <label>Max candidates per run (default 500)</label>
    <input type="number" id="set-cap" min="1" max="2000">
    <div class="row"><button id="set-save">Save settings</button></div>
    <div id="set-feedback" class="small dim"></div>
  `;
  $('set-save').addEventListener('click', saveSettings);
}

async function saveSettings() {
  const rate = Number($('set-rate').value);
  const cap = Number($('set-cap').value);
  const d = HHStorage.DEFAULTS.settings;
  if (rate < d.rateSeconds || cap > d.maxQueue) {
    const ok = confirm(
      'You are raising limits beyond the shipped defaults ' +
      `(faster than 1 req/${d.rateSeconds}s or more than ${d.maxQueue} per run).\n\n` +
      'This tool is meant to stay at personal scale. Pushing harder makes ' +
      'Instagram rate-limit or flag your own account — the extension will ' +
      'stop and back off when that happens, but the risk is yours.\n\nProceed?'
    );
    if (!ok) { refresh(); return; }
  }
  const resp = await chrome.runtime.sendMessage({
    type: 'HH_SET_SETTINGS', settings: { rateSeconds: rate, maxQueue: cap },
  });
  $('set-feedback').textContent = resp.ok ? 'Saved.' : resp.error;
  refresh();
}

function renderSettings(settings) {
  if (document.activeElement && ['set-rate', 'set-cap'].includes(document.activeElement.id)) return;
  $('set-rate').value = settings.rateSeconds;
  $('set-cap').value = settings.maxQueue;
}

// =======================================================================
// Wiring
// =======================================================================

let refreshQueued = false;
async function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(async () => {
    refreshQueued = false;
    const resp = await chrome.runtime.sendMessage({ type: 'HH_GET_STATE' });
    if (!resp || !resp.ok) return;
    lastState = resp;
    renderStatus(resp.run, resp.settings);
    renderTable();
    renderFavorites();
    renderSettings(resp.settings);
  }, 80);
}

function wire() {
  buildGeneratorPanel();
  buildSettingsPanel();

  $('paste-add').addEventListener('click', addToQueue);
  $('run-selftest').addEventListener('click', runSelfTest);

  $('pause-resume').addEventListener('click', async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'HH_TOGGLE_PAUSE' });
    if (resp && resp.ok === false && resp.error) $('paste-feedback').textContent = resp.error;
    refresh();
  });

  $('clear-queue').addEventListener('click', async () => {
    if (!confirm('Clear the current queue? Past results and favorites are kept.')) return;
    await chrome.runtime.sendMessage({ type: 'HH_CLEAR' });
    selected.clear();
    refresh();
  });

  for (const b of document.querySelectorAll('#filter-pills button')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const x of document.querySelectorAll('#filter-pills button')) x.classList.toggle('filter-on', x === b);
      renderTable();
    });
  }

  for (const th of document.querySelectorAll('#results-table th[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = k === 'checkedAt' ? -1 : 1; }
      renderTable();
    });
  }

  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) visibleRows().forEach((r) => selected.add(r.handle));
    else selected.clear();
    renderTable();
  });

  $('export-txt').addEventListener('click', () => exportRows('txt'));
  $('export-csv').addEventListener('click', () => exportRows('csv'));

  chrome.storage.onChanged.addListener(refresh);
  // Live countdown for the rate-limit banner.
  setInterval(() => { if (lastState) renderBanner(lastState.run); }, 15000);
  refresh();
}

wire();
