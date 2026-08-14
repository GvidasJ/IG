// options.js — dashboard view. Skeleton for now; generator, table, export and
// favorites are wired up in later commits. All state comes from storage /
// background messages; no queue logic lives in this page.

'use strict';

const $ = (id) => document.getElementById(id);

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'HH_GET_STATE' });
  if (!resp || !resp.ok) return;
  renderStatus(resp.run, resp.settings);
}

function renderStatus(run, settings) {
  const stateEl = $('run-state');
  stateEl.textContent = run.state.replace(/_/g, ' ');
  stateEl.className = 'pill ' + (run.state === 'running' ? 'AVAILABLE' : run.state === 'idle' || run.state === 'done' ? 'PENDING' : 'UNKNOWN');

  const total = run.order.length;
  const done = run.order.filter((h) => run.items[h] && run.items[h].state !== 'PENDING').length;
  $('run-progress').textContent = total ? `${done}/${total} checked` : 'no queue';
  $('run-rate').textContent = `~1 req / ${settings.rateSeconds}s`;
  $('progress-fill').style.width = total ? `${(100 * done) / total}%` : '0';

  const banner = $('banner');
  if (run.stateReason && !['idle', 'running', 'done'].includes(run.state)) {
    banner.textContent = run.stateReason;
    banner.className = 'banner ' + (run.state === 'canary_failed' ? 'error' : 'warn');
  } else {
    banner.className = 'banner hidden';
  }
}

chrome.storage.onChanged.addListener(refresh);
refresh();
