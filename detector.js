// detector.js — ALL availability-classification knowledge lives in this file.
// When Instagram changes something and results go wrong, fix THIS file first;
// the queue engine, content script and UI don't encode any Instagram behavior.
//
// ── What was verified empirically, and when ────────────────────────────────
// Verified 2026-08-14, logged OUT (anonymous requests):
//   * Profile HTML pages are useless: /instagram/, /nasa/ and a 20-char random
//     string ALL return an identical 302 -> /accounts/login/. No signal.
//     (This is why the old status-code script produced garbage.)
//   * The web app's own profile API, /api/v1/users/web_profile_info/?username=X,
//     returns 401 {"message":"Please wait a few minutes...","require_login":true}
//     for every username when anonymous. Also no signal.
// Conclusion: availability is only detectable from a LOGGED-IN session, via
// that same profile API. The logged-in response shapes below (user object for
// taken, explicit user-null / "User not found" for free) could NOT be verified
// from the build environment — they are what Instagram's web client itself
// consumes, but treat them as unproven until the canary passes in YOUR
// browser. The canary check exists precisely to catch this: if it fails on
// first run, these rules are wrong for the current Instagram and need updating.
//
// ── Classification contract ────────────────────────────────────────────────
// classify(candidate, obs) -> { state, reason, signal }
//   state:  'AVAILABLE' | 'TAKEN' | 'UNKNOWN'   (never anything else)
//   reason: short human-readable string, always set for UNKNOWN
//   signal: null | 'RATE_LIMIT' | 'AUTH' | 'CHALLENGE'
//           (queue-level advice: pause hard on any non-null signal)
//
// Core principle: AVAILABLE and TAKEN require a POSITIVE signal. Absence of
// evidence — empty bodies, HTML walls, weird statuses — is always UNKNOWN.

'use strict';

const HHDetector = (() => {
  const VERSION = '2026-08-14';

  // The app id Instagram's own web client sends with this API call. This is a
  // required parameter of the site's public web API, sent same-origin from the
  // user's real session — it is not identity spoofing (the UA, cookies, IP and
  // origin are all genuinely the user's).
  const IG_APP_ID = '936619743392459';

  // Known-taken canary. If this ever classifies as anything but TAKEN, the
  // detector is broken and the whole run must abort.
  const CANARY_TAKEN = 'instagram';

  function buildRequest(username) {
    return {
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      headers: { 'x-ig-app-id': IG_APP_ID },
    };
  }

  // A fresh random canary each run: 24 lowercase alphanumerics. Long random
  // strings are as close to guaranteed-unregistered as exists; if one doesn't
  // classify AVAILABLE, the detector can't be trusted to report AVAILABLE.
  function makeCanaryRandom() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const bytes = new Uint8Array(24);
    (globalThis.crypto || {}).getRandomValues
      ? crypto.getRandomValues(bytes)
      : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256)));
    for (const b of bytes) s += alphabet[b % alphabet.length];
    // Must start with a letter and contain no dots — keep it trivially valid.
    return 'hh' + s.slice(2);
  }

  function classify(candidate, obs) {
    const U = (state, reason, signal = null) => ({ state, reason, signal });

    if (!obs || obs.error) {
      return U('UNKNOWN', `network error: ${obs && obs.error || 'no observation'}`);
    }

    const status = obs.status;
    const json = obs.json || null;
    const msg = json && typeof json.message === 'string' ? json.message : '';

    // ---- Hard-stop signals first (these pause the queue) ----------------

    // Rate limiting. Instagram phrases it as "Please wait a few minutes
    // before you try again." and/or uses 429.
    if (status === 429 || /wait a few minutes/i.test(msg)) {
      return U('UNKNOWN', `rate-limited (HTTP ${status}${msg ? `: "${msg}"` : ''})`, 'RATE_LIMIT');
    }

    // Logged out / session invalid. When anonymous, this API 401s with
    // require_login:true (verified 2026-08-14).
    if ((json && json.require_login === true) || status === 401 || status === 403) {
      return U('UNKNOWN', `auth required (HTTP ${status}) — are you logged in to Instagram?`, 'AUTH');
    }

    // Checkpoint / challenge — Instagram wants human interaction. Never
    // attempt to work around this; pause and let the user handle it.
    if (json && (msg === 'checkpoint_required' || json.checkpoint_url ||
                 msg === 'challenge_required' || json.challenge)) {
      return U('UNKNOWN', 'Instagram is asking for a manual challenge/checkpoint', 'CHALLENGE');
    }

    // ---- Positive TAKEN / AVAILABLE signals -----------------------------

    // Shape consumed by Instagram's own web client:
    //   taken:  200 {"data":{"user":{ "username": "...", ... }},"status":"ok"}
    //   free:   200 {"data":{"user":null},"status":"ok"}
    if (status === 200 && json && json.data && Object.prototype.hasOwnProperty.call(json.data, 'user')) {
      const user = json.data.user;
      if (user === null) {
        return U('AVAILABLE', 'API positively reports no such user');
      }
      if (user && typeof user === 'object' && typeof user.username === 'string') {
        if (user.username.toLowerCase() === String(candidate).toLowerCase()) {
          return U('TAKEN', 'API returned the account');
        }
        return U('UNKNOWN', `API returned a different account ("${user.username}") — redirect or rename?`);
      }
      return U('UNKNOWN', 'API returned a malformed user object');
    }

    // Alternate free shape: the profile API 404s for nonexistent users. The
    // exact JSON wording has changed over time ("User not found", "Not
    // Found", ...), so any parseable JSON API error with 404 counts as a
    // positive miss. This stays canary-guarded: if Instagram ever starts
    // 404ing EVERYTHING (block wall), the known-taken canary also reads
    // AVAILABLE and the run aborts. (Rule loosened 2026-08-15 after a live
    // canary failure: logged-in 404 body no longer matched "User not found".)
    if (status === 404 && json) {
      return U('AVAILABLE', `API 404 for this username${msg ? ` ("${msg}")` : ''}`);
    }
    if (status === 404) {
      return U('UNKNOWN', `HTTP 404 with non-JSON body (${obs.contentType || 'unknown type'}) — not trusting it`);
    }

    // ---- Everything else is UNKNOWN -------------------------------------

    if (obs.contentType && /text\/html/i.test(obs.contentType)) {
      return U('UNKNOWN', `got an HTML page instead of API JSON (HTTP ${status}) — login wall or interstitial?`);
    }
    if (!json) {
      return U('UNKNOWN', `unparseable response (HTTP ${status})`);
    }
    return U('UNKNOWN', `unrecognized response shape (HTTP ${status}${msg ? `: "${msg}"` : ''})`);
  }

  // ---- Canary -----------------------------------------------------------
  // Run before every batch: one known-taken handle and one long random string.
  // evaluateCanary returns { ok, failures: [string] } given the two classified
  // results. Any failure means: abort the run, loud error, produce no list.
  function evaluateCanary(takenResult, randomResult) {
    const failures = [];
    if (takenResult.state !== 'TAKEN') {
      failures.push(`known-taken "@${CANARY_TAKEN}" classified ${takenResult.state} (${takenResult.reason})`);
    }
    if (randomResult.state !== 'AVAILABLE') {
      failures.push(`random string classified ${randomResult.state} (${randomResult.reason})`);
    }
    return { ok: failures.length === 0, failures };
  }

  return { VERSION, CANARY_TAKEN, buildRequest, makeCanaryRandom, classify, evaluateCanary };
})();

if (typeof globalThis !== 'undefined') globalThis.HHDetector = HHDetector;
