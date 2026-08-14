// background.js — MV3 service worker. Owns the queue and the timer.
// The content script (on instagram.com) does the actual fetching; this worker
// decides *when* to check, classifies raw observations via detector.js, and
// persists everything to chrome.storage.local.

'use strict';

importScripts('storage.js', 'detector.js', 'validation.js', 'queue.js');

const WATCHDOG_ALARM = 'hh-watchdog';

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
      return { ok: true, ...(await HHStorage.getAll()), detectorVersion: HHDetector.VERSION };

    case 'HH_ENQUEUE': {
      const summary = await HHQueue.enqueue(msg.handles, { force: !!msg.force });
      return { ok: true, summary };
    }

    case 'HH_START':
      return HHQueue.start();

    case 'HH_TOGGLE_PAUSE':
      return HHQueue.togglePause();

    case 'HH_CLEAR':
      return HHQueue.clear();

    case 'HH_QUICK_CHECK':
      return HHQueue.checkOne(msg.handle, { force: false });

    case 'HH_RECHECK':
      // Single manual retry of an UNKNOWN row. Not a loop.
      return HHQueue.checkOne(msg.handle, { force: true });

    case 'HH_SET_SETTINGS': {
      // Sanity clamps; the UI is responsible for warning before raising
      // limits, the engine just refuses outright-dangerous values.
      const s = await HHStorage.get('settings');
      const patch = msg.settings || {};
      if (patch.rateSeconds !== undefined) {
        s.rateSeconds = Math.min(Math.max(Number(patch.rateSeconds) || 4, 1), 3600);
      }
      if (patch.maxQueue !== undefined) {
        s.maxQueue = Math.min(Math.max(Math.round(Number(patch.maxQueue) || 500), 1), 2000);
      }
      if (patch.jitterFrac !== undefined) {
        s.jitterFrac = Math.min(Math.max(Number(patch.jitterFrac) || 0, 0), 2);
      }
      await HHStorage.set('settings', s);
      return { ok: true, settings: s };
    }

    case 'HH_SET_FAVORITE': {
      const favorites = await HHStorage.get('favorites');
      const h = HHValidation.normalize(msg.handle);
      const idx = favorites.indexOf(h);
      if (msg.on && idx === -1) favorites.push(h);
      if (!msg.on && idx !== -1) favorites.splice(idx, 1);
      await HHStorage.set('favorites', favorites);
      return { ok: true, favorites };
    }

    default:
      return { ok: false, error: `unknown message type: ${msg && msg.type}` };
  }
}

// ---- Lifecycle --------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await HHStorage.get('settings');
  await HHStorage.set('settings', settings);
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  // Browser restarted. If a run was live, park it paused rather than silently
  // firing requests the moment Chrome opens; progress is preserved and
  // resolved handles are never re-checked.
  const run = await HHStorage.get('run');
  if (run.state === 'running') {
    await HHStorage.update('run', {
      state: 'paused_restart',
      stateReason: 'Browser restarted mid-run. Progress is saved — press Resume.',
    });
  }
});

// Watchdog: if the worker was killed mid-run, storage still says "running";
// this restarts the loop. It never un-pauses anything.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) HHQueue.watchdog();
});
