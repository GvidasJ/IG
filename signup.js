// signup.js — the SECOND, separate question: not "does an account exist at
// this name?" (that's detector.js) but "will Instagram let me REGISTER this
// name?". Those differ constantly: 2-3 letter names and reserved/retired
// names have no profile yet can never be signed up.
//
// This asks Instagram's real signup username-validator — the same call the
// signup form makes as you type. It is STRICTLY one manual click per name;
// there is no bulk path, because this endpoint is the most abuse-monitored on
// the site. Like detector.js, every Instagram-specific rule is isolated here,
// and a canary proves the rule set before any answer is trusted.
//
// ── What is verified, and what is NOT ──────────────────────────────────────
// The endpoint and response shape below are what Instagram's web signup form
// uses, but they COULD NOT be verified from the build environment (logged
// out, and probing account-creation is exactly the traffic this tool refuses
// to generate at scale). Treat them as unproven until the signup canary
// passes in YOUR browser. If it fails, capture the real request from DevTools
// (Network tab while typing a username into instagram.com/accounts/emailsignup/)
// and the rule here gets pointed at exactly that.
//
// ── Safety: this must never actually create an account ─────────────────────
// The request deliberately sends an empty email and an unusable password, so
// account creation always fails at the account level while the server still
// reports whether the *username* itself is valid/available. The canary also
// guards this: if the endpoint ever started creating accounts or stopped
// validating usernames, the known-blocked canary would misclassify and abort.

'use strict';

const HHSignup = (() => {
  const VERSION = '2026-08-15';
  const IG_APP_ID = '936619743392459';
  const ENDPOINT = 'https://www.instagram.com/api/v1/web/accounts/web_create_ajax/attempt/';

  // Known-UNREGISTERABLE canary: a decade-old, permanently-held name. Must
  // come back BLOCKED. (Also confirms the endpoint validates usernames at all.)
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

  // The content script fills in the CSRF token (read from the cookie in page
  // context) — this module just names the endpoint, headers and body.
  function buildRequest(username) {
    const body = new URLSearchParams({
      // Deliberately unusable credentials so creation can never succeed.
      enc_password: '#PWD_INSTAGRAM_BROWSER:0:0:handlehunter_never_valid',
      email: '',
      first_name: '',
      username: String(username),
      client_id: 'handlehunter',
      seamless_login_enabled: '1',
      opt_into_one_tap: 'false',
    }).toString();

    return {
      url: ENDPOINT,
      method: 'POST',
      needsCsrf: true, // content script adds X-CSRFToken from the cookie
      headers: {
        'x-ig-app-id': IG_APP_ID,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    };
  }

  // Pull username-specific error messages out of the various shapes Instagram
  // has used: errors.username can be [string] or [{message}], and some
  // responses use a top-level message.
  function usernameErrors(json) {
    if (!json || !json.errors) return null;
    const u = json.errors.username;
    if (!u) return null;
    const arr = Array.isArray(u) ? u : [u];
    const msgs = arr.map((e) => (typeof e === 'string' ? e : (e && e.message) || '')).filter(Boolean);
    return msgs.length ? msgs : ['username rejected'];
  }

  // classify -> { state, reason }  state: REGISTERABLE | BLOCKED | UNKNOWN
  // Core rule: the response is a validation verdict ONLY if it parsed as JSON
  // and looks like the signup attempt response (has errors/status/account_created).
  // Within that: username error present -> BLOCKED; absent -> REGISTERABLE.
  // Anything else (HTML, login redirect, rate limit, unrecognized) -> UNKNOWN.
  function classify(candidate, obs) {
    const U = (state, reason, signal = null) => ({ state, reason, signal });
    if (!obs || obs.error) return U('UNKNOWN', `network error: ${obs && obs.error || 'no observation'}`);

    const status = obs.status;
    const json = obs.json || null;
    const topMsg = json && typeof json.message === 'string' ? json.message : '';

    if (status === 429 || /wait a few minutes/i.test(topMsg)) {
      return U('UNKNOWN', `rate-limited (HTTP ${status})`, 'RATE_LIMIT');
    }
    if (/csrf|referer|token/i.test(topMsg) || status === 403) {
      return U('UNKNOWN', `blocked/CSRF (HTTP ${status}${topMsg ? `: "${topMsg}"` : ''}) — reload instagram.com and retry`, 'AUTH');
    }
    if (/checkpoint|challenge/i.test(topMsg) || (json && (json.checkpoint_url || json.challenge))) {
      return U('UNKNOWN', 'Instagram asked for a manual challenge', 'CHALLENGE');
    }

    if (!json) {
      return U('UNKNOWN', `non-JSON response (HTTP ${status}, ${obs.contentType || 'unknown type'}) — signup validator not reachable from this session`);
    }

    // Must look like the signup-attempt response, or we don't trust it.
    const looksLikeAttempt =
      Object.prototype.hasOwnProperty.call(json, 'errors') ||
      Object.prototype.hasOwnProperty.call(json, 'account_created') ||
      json.status === 'ok' || json.status === 'fail';
    if (!looksLikeAttempt) {
      return U('UNKNOWN', `unrecognized signup response shape (HTTP ${status})`);
    }

    if (json.account_created === true) {
      // Should be impossible (empty email / bad password). Treat as registerable
      // but flag loudly — the safety assumption broke.
      return U('REGISTERABLE', '⚠ account was actually created — stop and check Instagram');
    }

    const uErr = usernameErrors(json);
    if (uErr) {
      return U('BLOCKED', uErr.join(' / '));
    }
    // No username error among the field errors -> the name itself is accepted.
    return U('REGISTERABLE', 'signup validator accepted the username (email/password errors ignored)');
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

  return { VERSION, CANARY_BLOCKED, ENDPOINT, buildRequest, makeCanaryRandom, classify, evaluateCanary, usernameErrors };
})();

if (typeof globalThis !== 'undefined') globalThis.HHSignup = HHSignup;
