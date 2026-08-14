// signup.js — the SECOND, separate question: not "does an account exist at
// this name?" (that's detector.js) but "will Instagram let me REGISTER this
// name?". Those differ constantly: 2-3 letter names and reserved/retired
// names have no profile yet can never be signed up.
//
// This calls Instagram's real signup field-validation GraphQL query — the
// exact call the web signup form fires as you type a username. Isolated here
// like detector.js, and guarded by its own canary before any verdict is
// trusted.
//
// ── Verified from a real capture (logged-in browser, 2026-08-15) ───────────
//   POST https://www.instagram.com/api/graphql
//   x-fb-friendly-name: useCAARegistrationFieldValidationQuery
//   body: form-urlencoded RelayModern call with doc_id + variables + lsd
//   variables: {"input":{"fetch_username_suggestions":true,
//               "field_name":"USERNAME",
//               "username":{"sensitive_string_value":"<name>"}},"scale":1}
//   FREE response:
//   {"data":{"xfb_caa_registration_field_validation":{"status":"SUCCESS",
//     "error":{"code":null,"field":"USERNAME","message":null,...},
//     "username_suggestions":[],...}}}
//   A TAKEN/blocked name fills error.message (e.g. "This username isn't
//   available.") and typically returns username_suggestions.
//
// ── What can go stale ──────────────────────────────────────────────────────
// doc_id changes when Instagram redeploys (every few weeks). When it does,
// the canary fails loud with the raw response instead of lying — update
// DOC_ID (and re-capture variables/response shape if they changed). The lsd
// token and jazoest are generated fresh at runtime (see content.js), so those
// don't go stale.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// This is a read-only *validation* query — it never creates an account, it
// only asks whether a username would be accepted. Still one manual click per
// name (or an opt-in batch at the same safe rate); never an evasive blast.

'use strict';

const HHSignup = (() => {
  const VERSION = '2026-08-15b';
  const IG_APP_ID = '936619743392459';
  const ASBD_ID = '359341';
  const ENDPOINT = 'https://www.instagram.com/api/graphql';
  const FRIENDLY_NAME = 'useCAARegistrationFieldValidationQuery';
  // Persisted-query id — the one field most likely to go stale on an IG deploy.
  const DOC_ID = '26387190147557007';

  // Known-UNREGISTERABLE canary: a decade-old, permanently-held name. Must
  // come back BLOCKED. Also confirms the query validates usernames at all.
  const CANARY_BLOCKED = 'instagram';

  function makeCanaryRandom() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const bytes = new Uint8Array(24);
    if ((globalThis.crypto || {}).getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (const b of bytes) s += alphabet[b % alphabet.length];
    return 'hh' + s.slice(2);
  }

  // The content script fills in the fresh lsd token (scraped from the page)
  // and the derived jazoest, replacing the placeholders below — it has page
  // context; this module just names the shape.
  function buildRequest(username) {
    const variables = JSON.stringify({
      input: {
        fetch_username_suggestions: true,
        field_name: 'USERNAME',
        username: { sensitive_string_value: String(username) },
      },
      scale: 1,
    });

    const body = [
      '__DYNPARAMS__',          // content.js injects av/__rev/__spin_*/__hs scraped from the page
      'lsd=__LSD__',            // replaced by content.js with the live token
      'jazoest=__JAZOEST__',    // replaced by content.js (derived from lsd)
      'fb_api_caller_class=RelayModern',
      `fb_api_req_friendly_name=${FRIENDLY_NAME}`,
      `variables=${encodeURIComponent(variables)}`,
      'server_timestamps=true',
      `doc_id=${DOC_ID}`,
    ].join('&');

    return {
      url: ENDPOINT,
      method: 'POST',
      needsCsrf: true, // content script adds X-CSRFToken from the cookie
      needsLsd: true,  // content script scrapes lsd, derives jazoest, injects both
      headers: {
        'x-ig-app-id': IG_APP_ID,
        'x-asbd-id': ASBD_ID,
        'x-fb-friendly-name': FRIENDLY_NAME,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    };
  }

  // classify -> { state, reason, signal }
  //   state: REGISTERABLE | BLOCKED | UNKNOWN
  function classify(candidate, obs) {
    const U = (state, reason, signal = null) => ({ state, reason, signal });
    if (!obs || obs.error) return U('UNKNOWN', `network error: ${obs && obs.error || 'no observation'}`);

    const status = obs.status;
    const json = obs.json || null;
    const topMsg = json && typeof json.message === 'string' ? json.message : '';

    if (status === 429 || /wait a few minutes/i.test(topMsg)) {
      return U('UNKNOWN', `rate-limited (HTTP ${status})`, 'RATE_LIMIT');
    }
    if (status === 403 || /csrf|lsd|token|login_required/i.test(topMsg)) {
      return U('UNKNOWN', `blocked/token (HTTP ${status}${topMsg ? `: "${topMsg}"` : ''}) — reload instagram.com and retry`, 'AUTH');
    }
    if (/checkpoint|challenge/i.test(topMsg)) {
      return U('UNKNOWN', 'Instagram asked for a manual challenge', 'CHALLENGE');
    }

    if (!json) {
      return U('UNKNOWN', `non-JSON response (HTTP ${status}, ${obs.contentType || 'unknown type'}) — signup query not reachable from this session`);
    }

    // Meta request-level rejection envelope: {"__ar":1,"error":<code>,
    // "errorSummary":...,"errorDescription":...}. Means the request was
    // malformed/stale (e.g. missing build params) or throttled.
    if (json.errorSummary || typeof json.error === 'number') {
      const desc = json.errorDescription || json.errorSummary || '';
      if (/try again|too many|temporarily/i.test(desc)) {
        return U('UNKNOWN', `Meta throttled the request (error ${json.error}): ${desc}`, 'RATE_LIMIT');
      }
      return U('UNKNOWN', `Meta rejected the request (error ${json.error}): ${desc}`);
    }

    // GraphQL top-level errors (bad doc_id, bad lsd, auth, throttle, ...).
    if (Array.isArray(json.errors) && json.errors.length) {
      const m = json.errors[0] && (json.errors[0].message || json.errors[0].description) || 'graphql error';
      if (/rate|throttle|wait a few minutes/i.test(m)) return U('UNKNOWN', `rate-limited: ${m}`, 'RATE_LIMIT');
      if (/csrf|lsd|token|login|auth|permission/i.test(m)) return U('UNKNOWN', `token/auth error: ${m}`, 'AUTH');
      return U('UNKNOWN', `graphql error: ${m} — doc_id may be stale (update signup.js)`);
    }

    const v = json.data && json.data.xfb_caa_registration_field_validation;
    if (v === undefined) {
      return U('UNKNOWN', 'unrecognized signup response shape — doc_id/query may have changed (update signup.js)');
    }
    if (v === null) {
      return U('UNKNOWN', 'validation returned null');
    }

    const err = v.error || {};
    const hasError = (err.message != null && err.message !== '') || (err.code != null && err.code !== '');
    if (hasError) {
      const suff = Array.isArray(v.username_suggestions) && v.username_suggestions.length
        ? ` (suggested: ${v.username_suggestions.slice(0, 3).join(', ')})` : '';
      return U('BLOCKED', `${err.message || err.code}${suff}`);
    }
    if (v.status === 'SUCCESS') {
      return U('REGISTERABLE', 'signup validator accepted the username');
    }
    return U('UNKNOWN', `unexpected validation status "${v.status}"`);
  }

  // Canary: known-blocked must be BLOCKED, fresh random must be REGISTERABLE.
  function evaluateCanary(blockedResult, randomResult) {
    const failures = [];
    if (blockedResult.state !== 'BLOCKED') {
      failures.push(`known-blocked "@${CANARY_BLOCKED}" classified ${blockedResult.state} (${blockedResult.reason})`);
    }
    if (randomResult.state !== 'REGISTERABLE') {
      failures.push(`random string classified ${randomResult.state} (${randomResult.reason})`);
    }
    return { ok: failures.length === 0, failures };
  }

  // jazoest is derived from the lsd token: "2" + sum of char codes. Exposed so
  // content.js and tests share one definition. (Verified against a live
  // capture: token "AdR3K0P_1jK8Lw3nrQXicPsi4sk" -> jazoest 22299.)
  function jazoest(token) {
    let sum = 0;
    for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i);
    return '2' + sum;
  }

  return { VERSION, CANARY_BLOCKED, ENDPOINT, DOC_ID, buildRequest, makeCanaryRandom, classify, evaluateCanary, jazoest };
})();

if (typeof globalThis !== 'undefined') globalThis.HHSignup = HHSignup;
