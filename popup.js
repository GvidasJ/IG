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

$('quick-go').addEventListener('click', async () => {
  $('quick-result').textContent = 'Queue engine not built yet.';
});

chrome.storage.onChanged.addListener(refresh);
refresh();
