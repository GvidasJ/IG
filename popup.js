// popup.js — thin view over stored state. No queue logic lives here.

'use strict';

const $ = (id) => document.getElementById(id);

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'HH_GET_STATE' });
  if (!resp || !resp.ok) return;
  renderRun(resp.run);
}

function renderRun(run) {
  const stateEl = $('run-state');
  stateEl.textContent = run.state.replace(/_/g, ' ');
  stateEl.className = 'pill ' + (run.state === 'running' ? 'AVAILABLE' : run.state === 'idle' || run.state === 'done' ? 'PENDING' : 'UNKNOWN');

  const total = run.order.length;
  const done = run.order.filter((h) => run.items[h] && run.items[h].state !== 'PENDING').length;
  $('run-progress').textContent = total ? `${done}/${total} checked` : 'no queue';

  const btn = $('pause-resume');
  btn.disabled = run.state === 'idle' || run.state === 'done' || run.state === 'canary_failed';
  btn.textContent = run.state === 'running' ? 'Pause' : 'Resume';

  const banner = $('banner');
  if (run.stateReason && run.state !== 'idle' && run.state !== 'running' && run.state !== 'done') {
    banner.textContent = run.stateReason;
    banner.className = 'banner ' + (run.state === 'canary_failed' ? 'error' : 'warn');
  } else {
    banner.className = 'banner hidden';
  }
}

$('open-dashboard').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Wired up for real when the queue engine lands.
$('pause-resume').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'HH_TOGGLE_PAUSE' });
  refresh();
});

async function quickCheck() {
  const handle = $('quick-input').value.trim();
  if (!handle) return;
  $('quick-result').textContent = 'queued (canary runs first if stale)…';
  const resp = await chrome.runtime.sendMessage({ type: 'HH_QUICK_CHECK', handle });
  if (!resp.ok) {
    $('quick-result').textContent = resp.error;
    return;
  }
  if (resp.alreadyResolved) {
    $('quick-result').textContent = `already resolved: ${resp.alreadyResolved} (re-check from the dashboard)`;
    return;
  }
  pollQuickResult(handle.toLowerCase().replace(/^@/, ''));
}

// Watch storage until the handle resolves; the popup may be closed at any
// time — the check continues in the background either way.
function pollQuickResult(handle) {
  const listener = async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'HH_GET_STATE' });
    if (!resp || !resp.ok) return;
    const item = resp.run.items[handle];
    if (item && item.state !== 'PENDING') {
      $('quick-result').innerHTML = '';
      const pill = document.createElement('span');
      pill.className = 'pill ' + item.state;
      pill.textContent = item.state;
      $('quick-result').append(pill, item.reason ? ` ${item.reason}` : '');
      chrome.storage.onChanged.removeListener(listener);
    }
  };
  chrome.storage.onChanged.addListener(listener);
}

$('quick-go').addEventListener('click', quickCheck);
$('quick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickCheck(); });

chrome.storage.onChanged.addListener(refresh);
refresh();
