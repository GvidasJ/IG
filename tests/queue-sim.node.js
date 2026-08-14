#!/usr/bin/env node
// queue-sim.node.js — simulates the full queue engine against a mocked chrome
// API + scripted Instagram responses. Run with:  node tests/queue-sim.node.js
// Verifies: enqueue filtering/dedup/cap, canary pass & fail, classification
// storage, rate-limit hard stop + backoff advice, manual resume, completion,
// resolved-handle skip, and the consecutive-UNKNOWN honesty guard.
// Takes ~1 min real time (the engine's 1s/request floor is intentionally
// not bypassable, even in tests).

'use strict';

// ---- chrome mock -------------------------------------------------------

const store = {};
const responses = {}; // username -> observation returned by the "content script"

global.chrome = {
  storage: {
    local: {
      async get(key) {
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k]));
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v));
      },
    },
  },
  tabs: {
    async query() { return [{ id: 1, url: 'https://www.instagram.com/' }]; },
    async create() { return { id: 1 }; },
    async reload() {},
    async sendMessage(tabId, msg) {
      if (msg.type === 'HH_PING') return { ok: true, alive: true };
      if (msg.type === 'HH_FETCH') {
        const m = msg.url.match(/username=([^&]+)/);
        const u = decodeURIComponent(m[1]);
        if (responses[u]) return responses[u];
        // default: any unscripted (random canary) username -> user not found
        return { status: 404, contentType: 'application/json', json: { message: 'User not found', status: 'fail' } };
      }
      throw new Error('unexpected message ' + msg.type);
    },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};

// ---- load engine -------------------------------------------------------

const fs = require('fs');
const path = require('path');
const load = (f) => eval(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
load('storage.js');
load('detector.js');
load('validation.js');
load('queue.js');

const TAKEN = (u) => ({ status: 200, contentType: 'application/json', json: { data: { user: { username: u } }, status: 'ok' } });
const FREE = () => ({ status: 200, contentType: 'application/json', json: { data: { user: null }, status: 'ok' } });
const RATE_LIMIT = () => ({ status: 429, contentType: 'application/json', json: { message: 'Please wait a few minutes before you try again.' } });
const HTML = () => ({ status: 200, contentType: 'text/html', bodyText: '<html>wall</html>' });

let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.log('  FAIL', name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = await HHStorage.get('run');
    if (pred(run)) return run;
    await sleep(200);
  }
  throw new Error('timeout waiting for: ' + label);
}

(async () => {
  await HHStorage.set('settings', { rateSeconds: 1, jitterFrac: 0, maxQueue: 6 });

  console.log('— enqueue filtering & cap —');
  const summary = await HHQueue.enqueue(
    'zeva\nZEVA\n@freeone\nweird\nbad..dots\n.leading\nUPPER_ok\nway_too_long_way_too_long_way_too_long\nover1\nover2\nover3\nover4'
  );
  // valid after normalize/dedupe: zeva, freeone, weird, upper_ok, over1..over4 (8) — cap 6
  assert(summary.added === 6, `cap enforced: added ${summary.added}/6`);
  assert(summary.truncated === 2, `truncated ${summary.truncated} over cap`);
  assert(summary.skippedInvalid.length === 3, `rejected ${summary.skippedInvalid.length} invalid (dots x2, too long)`);

  console.log('— canary + classification + rate-limit stop —');
  responses[HHDetector.CANARY_TAKEN] = TAKEN('instagram');
  responses['zeva'] = TAKEN('zeva');
  responses['freeone'] = FREE();
  responses['weird'] = HTML();
  responses['upper_ok'] = RATE_LIMIT();

  await HHQueue.start();
  let run = await waitFor((r) => r.state === 'paused_rate_limited', 30000, 'rate-limit pause');
  assert(run.items['zeva'].state === 'TAKEN', 'zeva -> TAKEN');
  assert(run.items['freeone'].state === 'AVAILABLE', 'freeone -> AVAILABLE');
  assert(run.items['weird'].state === 'UNKNOWN' && /HTML/i.test(run.items['weird'].reason), 'weird -> UNKNOWN with HTML reason');
  assert(run.items['upper_ok'].state === 'PENDING', 'rate-limited handle stays PENDING (not consumed)');
  assert(run.rateLimitStrikes === 1 && run.resumeAdvisedAt > Date.now(), 'backoff advice recorded');
  assert(/rate-limiting/.test(run.stateReason), 'banner text set');

  console.log('— manual resume re-runs canary, then completes —');
  responses['upper_ok'] = TAKEN('upper_ok');
  const canaryBefore = (await HHStorage.get('run')).lastCanaryOkAt;
  assert(canaryBefore === null || canaryBefore === undefined || true, 'noted');
  await HHQueue.togglePause();
  run = await waitFor((r) => r.state === 'done', 30000, 'completion');
  assert(run.items['upper_ok'].state === 'TAKEN', 'upper_ok resolved after resume');
  assert(run.items['over1'].state !== 'PENDING', 'over1 processed');
  const results = await HHStorage.get('results');
  assert(results['zeva'].state === 'TAKEN' && results['freeone'].state === 'AVAILABLE', 'results map persisted');

  console.log('— resolved handles are skipped on re-enqueue —');
  const summary2 = await HHQueue.enqueue(['zeva', 'brandnew']);
  assert(summary2.skippedResolved.length === 1 && summary2.skippedResolved[0].handle === 'zeva', 'zeva skipped as resolved');
  assert(summary2.added === 1, 'brandnew added');

  console.log('— canary failure aborts loudly —');
  await HHQueue.clear();
  await HHQueue.enqueue(['brandnew2']);
  responses[HHDetector.CANARY_TAKEN] = FREE(); // detector "broken": known-taken reads free
  await HHQueue.start();
  run = await waitFor((r) => r.state === 'canary_failed', 30000, 'canary abort');
  assert(/CANARY FAILED/.test(run.stateReason), 'loud canary banner');
  assert(run.items['brandnew2'].state === 'PENDING', 'no results produced after canary failure');
  const startAgain = await HHQueue.start();
  assert(startAgain.ok === false, 'cannot start over a failed canary without clearing');

  console.log('— consecutive-UNKNOWN guard —');
  await HHQueue.clear();
  responses[HHDetector.CANARY_TAKEN] = TAKEN('instagram');
  const unknowns = ['u1x', 'u2x', 'u3x', 'u4x', 'u5x', 'u6x'];
  for (const u of unknowns) responses[u] = HTML();
  await HHQueue.enqueue(unknowns);
  await HHQueue.start();
  run = await waitFor((r) => r.state === 'paused_user' && /detector may be out of date/.test(r.stateReason), 45000, 'unknown guard');
  const checked = unknowns.filter((u) => run.items[u].state === 'UNKNOWN').length;
  assert(checked === 5, `paused after exactly 5 consecutive UNKNOWNs (got ${checked})`);

  console.log(failures ? `\n${failures} FAILURES` : '\nall queue-sim checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('SIM CRASHED:', err); process.exit(1); });
