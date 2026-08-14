// queue.js — the queue engine, run inside the background service worker.
// Owns pacing (rate limit + jitter), the hard candidate cap, canary checks,
// pause/resume, exponential backoff on rate limits, and persistence.
//
// Design constraints (deliberate, do not "optimize" away):
//  * Personal scale: hard cap on queue size, >= 1s between requests, jitter
//    only ever ADDS delay.
//  * On any RATE_LIMIT / AUTH / CHALLENGE signal: stop the whole queue and
//    require a manual resume. No automatic retry, ever.
//  * Canary before processing: a known-taken handle and a fresh random string
//    must classify correctly or the run aborts loudly (state canary_failed).
//  * Everything persisted to chrome.storage.local so the run survives worker
//    death and browser restarts without re-checking resolved handles.

'use strict';

const HHQueue = (() => {
  // Module-level (worker-lifetime) loop guard. If the worker dies, storage
  // still says state=running and the watchdog alarm restarts the loop.
  let loopToken = 0;
  let consecutiveUnknowns = 0;

  const RESOLVED = new Set(['AVAILABLE', 'TAKEN']);
  const PAUSED_STATES = new Set([
    'paused_user', 'paused_rate_limited', 'paused_logged_out',
    'paused_challenge', 'paused_tab', 'paused_restart',
  ]);
  const CANARY_TTL_MS = 10 * 60 * 1000; // re-run canary if older than this

  // ---- Enqueue ----------------------------------------------------------

  // handles: array or newline string. force=true allows re-adding handles
  // whose stored result is UNKNOWN (a single manual retry) — never silently.
  async function enqueue(raw, { force = false } = {}) {
    const { valid, rejected } = HHValidation.filterList(raw);
    const [run, results, settings] = await Promise.all(
      ['run', 'results', 'settings'].map((k) => HHStorage.get(k))
    );

    if (run.state === 'done' || run.state === 'canary_failed') {
      // Old run is finished — start a fresh one, keeping global results.
      Object.assign(run, HHStorage.clone(HHStorage.DEFAULTS.run));
    }

    const summary = {
      added: 0,
      skippedInvalid: rejected,
      skippedResolved: [],
      skippedDupe: 0,
      truncated: 0,
    };

    const cap = Math.max(1, Math.min(settings.maxQueue, 2000));
    for (const h of valid) {
      if (run.items[h]) { summary.skippedDupe++; continue; }
      const prior = results[h];
      if (prior && RESOLVED.has(prior.state) && !force) {
        summary.skippedResolved.push({ handle: h, state: prior.state });
        continue;
      }
      if (run.order.length >= cap) { summary.truncated++; continue; }
      run.order.push(h);
      run.items[h] = { state: 'PENDING', reason: '', checkedAt: null };
      summary.added++;
    }

    await HHStorage.set('run', run);
    return summary;
  }

  // ---- Run control ------------------------------------------------------

  async function start() {
    const run = await HHStorage.get('run');
    if (run.state === 'running') return { ok: true, already: true };
    if (run.state === 'canary_failed') {
      return { ok: false, error: 'Canary failed — the detector needs fixing (or clear the queue to acknowledge).' };
    }
    if (!run.order.some((h) => run.items[h].state === 'PENDING')) {
      return { ok: false, error: 'Nothing pending in the queue.' };
    }
    run.state = 'running';
    run.stateReason = '';
    run.startedAt = run.startedAt || Date.now();
    run.lastTickAt = Date.now();
    await HHStorage.set('run', run);
    kickLoop();
    return { ok: true };
  }

  async function pause(state = 'paused_user', reason = 'Paused.') {
    loopToken++; // invalidate any in-flight loop
    await HHStorage.update('run', { state, stateReason: reason });
  }

  async function togglePause() {
    const run = await HHStorage.get('run');
    if (run.state === 'running') {
      await pause('paused_user', 'Paused by you.');
      return { ok: true, state: 'paused_user' };
    }
    if (PAUSED_STATES.has(run.state)) {
      // Manual resume — the only way out of a rate-limit/auth/challenge pause.
      // Coming out of one of those, the canary cache is dropped so it re-runs.
      if (['paused_rate_limited', 'paused_logged_out', 'paused_challenge'].includes(run.state)) {
        run.lastCanaryOkAt = null;
        await HHStorage.set('run', run);
      }
      return start();
    }
    return start();
  }

  async function clear() {
    loopToken++;
    consecutiveUnknowns = 0;
    await HHStorage.set('run', HHStorage.clone(HHStorage.DEFAULTS.run));
    return { ok: true };
  }

  // Quick check / single re-check: enqueue one handle (force allows retrying
  // an UNKNOWN) and start if not already running. This is a single retry —
  // there is no auto-retry loop anywhere in this file.
  async function checkOne(handle, { force = false } = {}) {
    const v = HHValidation.validate(HHValidation.normalize(handle));
    if (!v.ok) return { ok: false, error: `invalid handle: ${v.reason}` };
    const run = await HHStorage.get('run');
    if (PAUSED_STATES.has(run.state)) {
      return { ok: false, error: 'Queue is paused — resume it first.' };
    }
    if (force) {
      // Allow a re-check even if a result exists: drop it from this run's
      // items so enqueue re-adds it.
      const h = HHValidation.normalize(handle);
      if (run.items[h]) {
        run.order = run.order.filter((x) => x !== h);
        delete run.items[h];
        await HHStorage.set('run', run);
      }
    }
    const summary = await enqueue([handle], { force });
    if (!summary.added && summary.skippedResolved.length) {
      const prior = summary.skippedResolved[0];
      return { ok: true, alreadyResolved: prior.state };
    }
    if (!summary.added && !summary.skippedDupe) {
      return { ok: false, error: 'could not queue handle' };
    }
    const started = await start();
    return started.ok ? { ok: true, queued: true } : started;
  }

  // ---- The loop ---------------------------------------------------------

  function kickLoop() {
    const token = ++loopToken;
    tick(token).catch(async (err) => {
      console.error('[HandleHunter] loop crashed:', err);
      await HHStorage.update('run', {
        state: 'paused_user',
        stateReason: `Internal error, run paused: ${String(err && err.message || err)}`,
      });
    });
  }

  async function tick(token) {
    while (true) {
      if (token !== loopToken) return; // superseded (pause/clear/newer loop)
      const run = await HHStorage.get('run');
      if (run.state !== 'running') return;
      const settings = await HHStorage.get('settings');

      // 1. Canary, if stale or never run.
      if (!run.lastCanaryOkAt || Date.now() - run.lastCanaryOkAt > CANARY_TTL_MS) {
        const canaryOk = await runCanary(token, settings);
        if (!canaryOk) return; // runCanary set the terminal/paused state
        await HHStorage.update('run', { lastCanaryOkAt: Date.now() });
        continue;
      }

      // 2. Next pending handle.
      const next = run.order.find((h) => run.items[h].state === 'PENDING');
      if (!next) {
        await HHStorage.update('run', {
          state: 'done',
          stateReason: '',
          lastTickAt: Date.now(),
        });
        return;
      }

      // 3. Check it.
      const { state, reason, signal } = await checkHandle(next);
      if (token !== loopToken) return;

      if (signal) {
        await handleSignal(signal, next, reason);
        return;
      }

      // Re-read before writing: the user may have enqueued more handles
      // while the request was in flight.
      const fresh = await HHStorage.get('run');
      if (fresh.state !== 'running' || !fresh.items[next]) return;
      fresh.items[next] = { state, reason, checkedAt: Date.now() };
      fresh.lastTickAt = Date.now();
      if (state !== 'UNKNOWN') fresh.rateLimitStrikes = 0;
      await HHStorage.set('run', fresh);

      const results = await HHStorage.get('results');
      results[next] = { state, reason, checkedAt: Date.now() };
      await HHStorage.set('results', results);

      // Honesty guard: a stretch of plain UNKNOWNs usually means the detector
      // is stale or Instagram is soft-blocking — stop burning requests on
      // garbage answers. Configurable; 0 disables it (the run then keeps going
      // through UNKNOWNs, which are still recorded honestly for later re-check).
      const limit = Number(settings.maxConsecutiveUnknowns) || 0;
      consecutiveUnknowns = state === 'UNKNOWN' ? consecutiveUnknowns + 1 : 0;
      if (limit > 0 && consecutiveUnknowns >= limit) {
        consecutiveUnknowns = 0;
        await pause(
          'paused_user',
          `${limit} consecutive UNKNOWN results — Instagram may be soft-blocking, or the detector is stale. Run paused. (Raise or disable this in Settings → "Pause after N unknowns".)`
        );
        return;
      }

      // 4. Wait: base rate + additive jitter. Never faster than the base.
      await sleep(delayMs(settings));
    }
  }

  function delayMs(settings) {
    const base = Math.max(1, Number(settings.rateSeconds) || 4) * 1000;
    const jitter = Math.max(0, Number(settings.jitterFrac) || 0);
    return Math.round(base * (1 + Math.random() * jitter));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---- Canary -----------------------------------------------------------

  async function runCanary(token, settings) {
    const takenRes = await checkHandle(HHDetector.CANARY_TAKEN);
    if (token !== loopToken) return false;
    if (takenRes.signal) { await handleSignal(takenRes.signal, '(canary)', takenRes.reason); return false; }

    await sleep(delayMs(settings));
    if (token !== loopToken) return false;

    const randomHandle = HHDetector.makeCanaryRandom();
    const randomRes = await checkHandle(randomHandle);
    if (token !== loopToken) return false;
    if (randomRes.signal) { await handleSignal(randomRes.signal, '(canary)', randomRes.reason); return false; }

    const verdict = HHDetector.evaluateCanary(takenRes, randomRes);
    if (!verdict.ok) {
      loopToken++;
      await HHStorage.update('run', {
        state: 'canary_failed',
        stateReason:
          'CANARY FAILED — the detector cannot be trusted and this run was aborted. ' +
          verdict.failures.join(' | ') +
          ' — Instagram has probably changed its responses; detector.js needs updating. No results were produced. ' +
          `Raw responses → ${describeObs('known-taken', takenRes)} ‖ ${describeObs('random', randomRes)}`,
      });
      return false;
    }
    await sleep(delayMs(settings));
    return token === loopToken;
  }

  // ---- Signals (rate limit / auth / challenge) --------------------------

  async function handleSignal(signal, handle, reason) {
    loopToken++;
    const run = await HHStorage.get('run');

    if (signal === 'RATE_LIMIT') {
      run.rateLimitStrikes = (run.rateLimitStrikes || 0) + 1;
      // Exponential backoff ADVICE: 5, 10, 20, 40, 80 min, capped at 2h.
      // Resuming is always manual; this is the recommended wait, not a timer
      // that auto-restarts anything.
      const mins = Math.min(5 * 2 ** (run.rateLimitStrikes - 1), 120);
      run.resumeAdvisedAt = Date.now() + mins * 60 * 1000;
      run.state = 'paused_rate_limited';
      run.stateReason =
        `Paused — Instagram is rate-limiting (${reason}). ` +
        `Wait ~${mins} min, then press Resume. Resuming early risks a longer block.`;
    } else if (signal === 'AUTH') {
      run.state = 'paused_logged_out';
      run.stateReason =
        `Paused — you appear to be logged out of Instagram (${reason}). ` +
        'Log in at instagram.com in a normal tab, then press Resume.';
    } else {
      run.state = 'paused_challenge';
      run.stateReason =
        `Paused — Instagram is asking for a manual challenge/checkpoint (${reason}). ` +
        'Open instagram.com, complete it yourself, then press Resume.';
    }
    run.lastTickAt = Date.now();
    await HHStorage.set('run', run);
  }

  // ---- Checking one handle via the content script -----------------------

  async function checkHandle(username) {
    const tab = await ensureInstagramTab();
    if (!tab.ok) {
      loopToken++;
      await HHStorage.update('run', { state: 'paused_tab', stateReason: tab.error });
      return { state: 'UNKNOWN', reason: tab.error, signal: null, aborted: true };
    }
    const req = HHDetector.buildRequest(username);
    let obs;
    try {
      obs = await chrome.tabs.sendMessage(tab.tabId, {
        type: 'HH_FETCH', url: req.url, headers: req.headers,
      });
    } catch (err) {
      obs = { error: `content script unreachable: ${String(err && err.message || err)}` };
    }
    // obs rides along so canary failures can show the raw response.
    return { ...HHDetector.classify(username, obs), obs };
  }

  // ---- Signup verification (the "can I actually register it?" check) -----
  // Strictly one manual call at a time. Never bulk. Its own canary. This is
  // the only place the extension POSTs anything, and the POST is built to
  // never create an account (empty email, unusable password).

  async function rawSignup(username) {
    const tab = await ensureInstagramTab();
    if (!tab.ok) return { state: 'UNKNOWN', reason: tab.error, signal: 'AUTH', obs: null };
    const req = HHSignup.buildRequest(username);
    let obs;
    try {
      obs = await chrome.tabs.sendMessage(tab.tabId, {
        type: 'HH_FETCH', url: req.url, method: req.method, headers: req.headers,
        body: req.body, needsCsrf: req.needsCsrf, needsLsd: req.needsLsd,
      });
    } catch (err) {
      obs = { error: `content script unreachable: ${String(err && err.message || err)}` };
    }
    return { ...HHSignup.classify(username, obs), obs };
  }

  async function verifySignup(handle) {
    const h = HHValidation.normalize(handle);
    const v = HHValidation.validate(h);
    if (!v.ok) return { ok: false, error: `invalid handle: ${v.reason}` };

    const run = await HHStorage.get('run');
    if (run.state === 'running') {
      return { ok: false, error: 'Pause the availability queue before verifying at signup (they share the rate limit).' };
    }
    const settings = await HHStorage.get('settings');

    // Canary first, cached briefly, exactly like the availability detector.
    if (!run.lastSignupCanaryOkAt || Date.now() - run.lastSignupCanaryOkAt > 10 * 60 * 1000) {
      const blocked = await rawSignup(HHSignup.CANARY_BLOCKED);
      if (blocked.signal) return { ok: false, error: `Signup check unavailable: ${blocked.reason}` };
      await sleep(delayMs(settings));
      const rnd = await rawSignup(HHSignup.makeCanaryRandom());
      if (rnd.signal) return { ok: false, error: `Signup check unavailable: ${rnd.reason}` };

      const verdict = HHSignup.evaluateCanary(blocked, rnd);
      if (!verdict.ok) {
        return {
          ok: false,
          canaryFailed: true,
          error:
            'SIGNUP CANARY FAILED — the signup validator behaves differently than expected, so no verdict is trusted. ' +
            verdict.failures.join(' | ') +
            `. Raw → ${describeObs('known-blocked', blocked)} ‖ ${describeObs('random', rnd)}`,
        };
      }
      await HHStorage.update('run', { lastSignupCanaryOkAt: Date.now() });
      await sleep(delayMs(settings));
    }

    const res = await rawSignup(h);
    if (res.signal) return { ok: false, error: `Signup check paused: ${res.reason}` };

    const signup = { state: res.state, reason: res.reason, checkedAt: Date.now() };
    const results = await HHStorage.get('results');
    results[h] = Object.assign(results[h] || {}, { signup });
    await HHStorage.set('results', results);

    const run2 = await HHStorage.get('run');
    if (run2.items[h]) { run2.items[h] = Object.assign(run2.items[h], { signup }); await HHStorage.set('run', run2); }

    return { ok: true, signup };
  }

  // ---- Signup BATCH: verify all AVAILABLE finalists, safely --------------
  // Same rate limit, jitter, canary and hard-stop-on-anti-bot as the
  // availability queue. Separate loop token and separate storage key so it
  // never interleaves with, or shares a request budget with, the main queue.

  let signupLoopToken = 0;

  // Collect handles worth verifying: latest availability verdict is AVAILABLE
  // and they don't already have a signup verdict (unless re-running).
  async function collectSignupTargets() {
    const [run, results] = await Promise.all([HHStorage.get('run'), HHStorage.get('results')]);
    const latest = new Map();
    for (const [h, r] of Object.entries(results)) latest.set(h, r);
    for (const h of run.order) latest.set(h, Object.assign({}, latest.get(h), run.items[h]));
    const targets = [];
    for (const [h, r] of latest.entries()) {
      if (r && r.state === 'AVAILABLE' && !(r.signup && r.signup.state)) targets.push(h);
    }
    return targets.sort();
  }

  async function startSignupBatch() {
    const run = await HHStorage.get('run');
    if (run.state === 'running') {
      return { ok: false, error: 'Pause the availability queue first — signup verification runs on its own so they never share the rate limit.' };
    }
    let sr = await HHStorage.get('signupRun');

    // Resume an interrupted batch, or build a fresh one.
    const hasPending = sr.order.some((h) => sr.items[h] && sr.items[h].state === 'PENDING');
    if (!hasPending || sr.state === 'done' || sr.state === 'idle') {
      const targets = await collectSignupTargets();
      if (!targets.length) {
        return { ok: false, error: 'No AVAILABLE names left to verify. Run an availability check first, or your finalists are already verified (see the Signup column).' };
      }
      const settings = await HHStorage.get('settings');
      const capped = targets.slice(0, settings.maxQueue);
      sr = HHStorage.clone(HHStorage.DEFAULTS.signupRun);
      sr.order = capped;
      for (const h of capped) sr.items[h] = { state: 'PENDING', reason: '', checkedAt: null };
      sr.truncated = targets.length - capped.length;
    }
    if (['paused_rate_limited', 'paused_logged_out', 'paused_challenge'].includes(sr.state)) {
      sr.lastCanaryOkAt = null; // re-prove after a block-pause
    }
    sr.state = 'running';
    sr.stateReason = '';
    sr.lastTickAt = Date.now();
    await HHStorage.set('signupRun', sr);
    kickSignupLoop();
    return { ok: true, count: sr.order.filter((h) => sr.items[h].state === 'PENDING').length };
  }

  async function toggleSignupPause() {
    const sr = await HHStorage.get('signupRun');
    if (sr.state === 'running') {
      signupLoopToken++;
      await HHStorage.update('signupRun', { state: 'paused_user', stateReason: 'Signup verification paused by you.' });
      return { ok: true, state: 'paused_user' };
    }
    return startSignupBatch();
  }

  function kickSignupLoop() {
    const token = ++signupLoopToken;
    signupTick(token).catch(async (err) => {
      console.error('[HandleHunter] signup loop crashed:', err);
      await HHStorage.update('signupRun', { state: 'paused_user', stateReason: `Internal error, signup batch paused: ${String(err && err.message || err)}` });
    });
  }

  async function signupTick(token) {
    while (true) {
      if (token !== signupLoopToken) return;
      const sr = await HHStorage.get('signupRun');
      if (sr.state !== 'running') return;
      const settings = await HHStorage.get('settings');

      // Canary before processing / after any block-pause.
      if (!sr.lastCanaryOkAt || Date.now() - sr.lastCanaryOkAt > 10 * 60 * 1000) {
        const ok = await runSignupCanary(token, settings);
        if (!ok) return;
        await HHStorage.update('signupRun', { lastCanaryOkAt: Date.now() });
        continue;
      }

      const next = sr.order.find((h) => sr.items[h].state === 'PENDING');
      if (!next) {
        await HHStorage.update('signupRun', { state: 'done', stateReason: '', lastTickAt: Date.now() });
        return;
      }

      const res = await rawSignup(next);
      if (token !== signupLoopToken) return;
      if (res.signal) { await signupHandleSignal(res.signal, res.reason); return; }

      const signup = { state: res.state, reason: res.reason, checkedAt: Date.now() };
      const results = await HHStorage.get('results');
      results[next] = Object.assign(results[next] || {}, { signup });
      await HHStorage.set('results', results);

      const fresh = await HHStorage.get('signupRun');
      if (fresh.state !== 'running' || !fresh.items[next]) return;
      fresh.items[next] = signup;
      fresh.lastTickAt = Date.now();
      if (res.state !== 'UNKNOWN') fresh.rateLimitStrikes = 0;
      await HHStorage.set('signupRun', fresh);

      await sleep(delayMs(settings));
    }
  }

  async function runSignupCanary(token, settings) {
    const blocked = await rawSignup(HHSignup.CANARY_BLOCKED);
    if (token !== signupLoopToken) return false;
    if (blocked.signal) { await signupHandleSignal(blocked.signal, blocked.reason); return false; }
    await sleep(delayMs(settings));
    if (token !== signupLoopToken) return false;
    const rnd = await rawSignup(HHSignup.makeCanaryRandom());
    if (token !== signupLoopToken) return false;
    if (rnd.signal) { await signupHandleSignal(rnd.signal, rnd.reason); return false; }

    const verdict = HHSignup.evaluateCanary(blocked, rnd);
    if (!verdict.ok) {
      signupLoopToken++;
      await HHStorage.update('signupRun', {
        state: 'paused_user',
        stateReason:
          'SIGNUP CANARY FAILED — signup verification aborted, no verdicts trusted. ' +
          verdict.failures.join(' | ') +
          `. Raw → ${describeObs('known-blocked', blocked)} ‖ ${describeObs('random', rnd)}`,
      });
      return false;
    }
    await sleep(delayMs(settings));
    return token === signupLoopToken;
  }

  async function signupHandleSignal(signal, reason) {
    signupLoopToken++;
    const sr = await HHStorage.get('signupRun');
    if (signal === 'RATE_LIMIT') {
      sr.rateLimitStrikes = (sr.rateLimitStrikes || 0) + 1;
      const mins = Math.min(5 * 2 ** (sr.rateLimitStrikes - 1), 120);
      sr.resumeAdvisedAt = Date.now() + mins * 60 * 1000;
      sr.state = 'paused_rate_limited';
      sr.stateReason = `Signup verification paused — Instagram is rate-limiting (${reason}). Wait ~${mins} min, then resume.`;
    } else if (signal === 'AUTH') {
      sr.state = 'paused_logged_out';
      sr.stateReason = `Signup verification paused — ${reason}`;
    } else {
      sr.state = 'paused_challenge';
      sr.stateReason = `Signup verification paused — Instagram wants a manual challenge (${reason}). Complete it, then resume.`;
    }
    sr.lastTickAt = Date.now();
    await HHStorage.set('signupRun', sr);
  }

  async function clearSignupBatch() {
    signupLoopToken++;
    await HHStorage.set('signupRun', HHStorage.clone(HHStorage.DEFAULTS.signupRun));
    return { ok: true };
  }

  // One-line raw-response summary for canary failure banners, so a broken
  // detector can be fixed from the banner alone instead of guessing.
  function describeObs(label, res) {
    const o = res && res.obs;
    if (!o) return `${label}: no observation`;
    if (o.error) return `${label}: ${o.error}`;
    const body = String(o.bodyText || '').replace(/\s+/g, ' ').slice(0, 160);
    return `${label}: HTTP ${o.status} [${o.contentType || 'no content-type'}] body: ${body || '(empty)'}`;
  }

  // Find (or open) an instagram.com tab with a live content script. The tab
  // is opened in the background, once, and reused; the user can watch it.
  async function ensureInstagramTab() {
    const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    for (const t of tabs) {
      if (await ping(t.id)) return { ok: true, tabId: t.id };
    }
    let tab;
    if (tabs.length) {
      // Tab exists but the content script isn't there (installed after the
      // tab loaded). Reload so the manifest-declared script attaches — this
      // avoids needing the broader "scripting" permission.
      tab = tabs[0];
      await chrome.tabs.reload(tab.id);
    } else {
      tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
    }
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await ping(tab.id)) return { ok: true, tabId: tab.id };
    }
    return {
      ok: false,
      error: 'Paused — could not reach the Instagram tab (it may have been closed or failed to load). Reopen instagram.com, then press Resume.',
    };
  }

  async function ping(tabId) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'HH_PING' });
      return !!(r && r.alive);
    } catch {
      return false;
    }
  }

  // ---- Watchdog ---------------------------------------------------------
  // Called from the 1-minute alarm: if storage says running but no tick has
  // happened recently (worker was killed mid-run), restart the loop.
  async function watchdog() {
    const settings = await HHStorage.get('settings');
    const staleAfter = Math.max(30000, settings.rateSeconds * 1000 * 3 + 15000);
    const run = await HHStorage.get('run');
    if (run.state === 'running' && (!run.lastTickAt || Date.now() - run.lastTickAt > staleAfter)) {
      kickLoop();
    }
    const sr = await HHStorage.get('signupRun');
    if (sr.state === 'running' && (!sr.lastTickAt || Date.now() - sr.lastTickAt > staleAfter)) {
      kickSignupLoop();
    }
  }

  return {
    enqueue, start, pause, togglePause, clear, checkOne, verifySignup,
    startSignupBatch, toggleSignupPause, clearSignupBatch,
    watchdog, kickLoop,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.HHQueue = HHQueue;
