// background.js — MV3 service worker. Owns the queue and the timer.
// The content script (on instagram.com) does the actual fetching; this worker
// decides *when* to check, classifies raw observations via detector.js, and
// persists everything to chrome.storage.local.

'use strict';

importScripts('storage.js');

// ---- Message routing --------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response
});

async function handleMessage(msg /*, sender */) {
  switch (msg && msg.type) {
    case 'HH_GET_STATE':
      return { ok: true, ...(await HHStorage.getAll()) };
    default:
      return { ok: false, error: `unknown message type: ${msg && msg.type}` };
  }
}

// ---- Lifecycle --------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults so the options page always has something to render.
  const settings = await HHStorage.get('settings');
  await HHStorage.set('settings', settings);
});

chrome.runtime.onStartup.addListener(async () => {
  // Browser restarted. If a run was live, park it paused rather than silently
  // firing requests the moment Chrome opens; progress is preserved.
  const run = await HHStorage.get('run');
  if (run.state === 'running') {
    await HHStorage.update('run', {
      state: 'paused_restart',
      stateReason: 'Browser restarted mid-run. Progress is saved — press Resume.',
    });
  }
});
