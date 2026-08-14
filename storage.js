// storage.js — schema, defaults, and thin promise helpers over chrome.storage.local.
// Loaded by the service worker (importScripts) and by popup/options pages (<script>).
// All state is local; nothing is synced or transmitted anywhere.

'use strict';

const HHStorage = (() => {
  // ---- Schema ----------------------------------------------------------
  //
  // settings: user-tunable knobs. Defaults ship conservative on purpose.
  // run:      the current (or last) queue run. Survives worker death and
  //           browser restarts; the queue engine resumes from `items`.
  // results:  handle -> latest resolved result, across runs. Used to avoid
  //           silently re-checking things already resolved.
  // favorites: array of handles the user starred.

  const DEFAULTS = {
    settings: {
      // Seconds between requests. Jitter is added on top (never subtracted),
      // so the real rate is always <= 1 request per rateSeconds.
      rateSeconds: 4,
      // Jitter fraction: each delay is rateSeconds * (1 + random()*jitterFrac).
      jitterFrac: 0.5,
      // Hard cap on candidates per run.
      maxQueue: 500,
    },
    run: {
      // idle | running | paused_user | paused_rate_limited | paused_logged_out
      // | paused_tab | paused_restart | canary_failed | done
      state: 'idle',
      stateReason: '',
      startedAt: null,
      // Ordered list of handles in this run.
      order: [],
      // handle -> { state: PENDING|AVAILABLE|TAKEN|UNKNOWN, reason, checkedAt }
      items: {},
      // Consecutive rate-limit strikes; drives the exponential backoff advice.
      rateLimitStrikes: 0,
      // Epoch ms after which resuming is advised (rate-limit backoff).
      resumeAdvisedAt: null,
      // Last successful canary: { at: epochMs } — cached briefly so a single
      // re-check doesn't cost two extra requests every time.
      lastCanaryOkAt: null,
      // Same idea for the separate signup-registerability canary.
      lastSignupCanaryOkAt: null,
      lastTickAt: null,
    },
    // Separate, opt-in batch that walks AVAILABLE finalists through the signup
    // validator at the SAME safe pace as the availability queue, with the same
    // canary gate and the same hard-stop-on-anti-bot behavior. Kept apart from
    // `run` so the two never share a request budget or interleave.
    signupRun: {
      // idle | running | paused_user | paused_rate_limited | paused_logged_out
      // | paused_challenge | paused_tab | paused_restart | done
      state: 'idle',
      stateReason: '',
      order: [],
      items: {}, // handle -> { state: PENDING|REGISTERABLE|BLOCKED|UNKNOWN, reason, checkedAt }
      rateLimitStrikes: 0,
      resumeAdvisedAt: null,
      lastCanaryOkAt: null,
      lastTickAt: null,
    },
    results: {},
    favorites: [],
  };

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  async function get(key) {
    const found = await chrome.storage.local.get(key);
    if (found[key] === undefined) return clone(DEFAULTS[key]);
    // Merge shallowly over defaults so new fields added in updates get values.
    if (DEFAULTS[key] && typeof DEFAULTS[key] === 'object' && !Array.isArray(DEFAULTS[key])) {
      return Object.assign(clone(DEFAULTS[key]), found[key]);
    }
    return found[key];
  }

  async function getAll() {
    const [settings, run, signupRun, results, favorites] = await Promise.all(
      ['settings', 'run', 'signupRun', 'results', 'favorites'].map(get)
    );
    return { settings, run, signupRun, results, favorites };
  }

  async function set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function update(key, patch) {
    const cur = await get(key);
    const next = Object.assign(cur, patch);
    await set(key, next);
    return next;
  }

  return { DEFAULTS, get, getAll, set, update, clone };
})();

// Make available to importScripts consumers (service worker) and page scripts.
if (typeof globalThis !== 'undefined') globalThis.HHStorage = HHStorage;
