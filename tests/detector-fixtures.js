// detector-fixtures.js — synthetic observations with expected classifications.
// These encode the CONTRACT of detector.js so rule edits are caught offline.
// They do NOT prove Instagram still behaves this way — only the live canary
// (and the dashboard's detector self-test) can prove that.

'use strict';

const HH_FIXTURES = [
  {
    name: 'taken: 200 with matching user object',
    candidate: 'instagram',
    obs: { status: 200, contentType: 'application/json', json: { data: { user: { username: 'instagram', full_name: 'Instagram' } }, status: 'ok' } },
    expect: { state: 'TAKEN', signal: null },
  },
  {
    name: 'taken: username case difference still matches',
    candidate: 'NASA',
    obs: { status: 200, contentType: 'application/json', json: { data: { user: { username: 'nasa' } }, status: 'ok' } },
    expect: { state: 'TAKEN', signal: null },
  },
  {
    name: 'available: 200 with explicit user:null',
    candidate: 'hhzq8xk2v9',
    obs: { status: 200, contentType: 'application/json', json: { data: { user: null }, status: 'ok' } },
    expect: { state: 'AVAILABLE', signal: null },
  },
  {
    name: 'available: 404 with explicit "User not found"',
    candidate: 'hhzq8xk2v9',
    obs: { status: 404, contentType: 'application/json', json: { message: 'User not found', status: 'fail' } },
    expect: { state: 'AVAILABLE', signal: null },
  },
  {
    name: 'available: 404 with any JSON API error (wording drifts, canary-guarded)',
    candidate: 'hhzq8xk2v9',
    obs: { status: 404, contentType: 'application/json', json: { message: 'Not Found', status: 'fail' } },
    expect: { state: 'AVAILABLE', signal: null },
  },
  {
    name: 'available: 404 HTML error page (observed live logged-in 2026-08-15)',
    candidate: 'hhzq8xk2v9',
    obs: { status: 404, contentType: 'text/html; charset=utf-8', bodyText: '<!DOCTYPE html> <html lang="en-gb" class="no-js logged-in "><title>Page Not Found</title>' },
    expect: { state: 'AVAILABLE', signal: null },
  },
  {
    name: 'rate limit: 429',
    candidate: 'whatever',
    obs: { status: 429, contentType: 'application/json', json: {} },
    expect: { state: 'UNKNOWN', signal: 'RATE_LIMIT' },
  },
  {
    name: 'rate limit: "wait a few minutes" message (as observed live 2026-08-14)',
    candidate: 'whatever',
    obs: { status: 401, contentType: 'application/json', json: { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' } },
    expect: { state: 'UNKNOWN', signal: 'RATE_LIMIT' },
  },
  {
    name: 'logged out: require_login without rate-limit message',
    candidate: 'whatever',
    obs: { status: 401, contentType: 'application/json', json: { message: 'login_required', require_login: true, status: 'fail' } },
    expect: { state: 'UNKNOWN', signal: 'AUTH' },
  },
  {
    name: 'logged out: plain 403',
    candidate: 'whatever',
    obs: { status: 403, contentType: 'application/json', json: { status: 'fail' } },
    expect: { state: 'UNKNOWN', signal: 'AUTH' },
  },
  {
    name: 'challenge: checkpoint_required',
    candidate: 'whatever',
    obs: { status: 400, contentType: 'application/json', json: { message: 'checkpoint_required', checkpoint_url: '/challenge/x', status: 'fail' } },
    expect: { state: 'UNKNOWN', signal: 'CHALLENGE' },
  },
  {
    name: 'suspicious: API returned a DIFFERENT account than asked',
    candidate: 'zeva',
    obs: { status: 200, contentType: 'application/json', json: { data: { user: { username: 'zeva_official' } }, status: 'ok' } },
    expect: { state: 'UNKNOWN', signal: null },
  },
  {
    name: 'login wall: HTML served with 200',
    candidate: 'whatever',
    obs: { status: 200, contentType: 'text/html; charset=utf-8', bodyText: '<!DOCTYPE html><html>login</html>' },
    expect: { state: 'UNKNOWN', signal: null },
  },
  {
    name: 'empty/unparseable 200 is NOT available',
    candidate: 'whatever',
    obs: { status: 200, contentType: 'application/json', bodyText: '' },
    expect: { state: 'UNKNOWN', signal: null },
  },
  {
    name: 'malformed user object is NOT taken',
    candidate: 'whatever',
    obs: { status: 200, contentType: 'application/json', json: { data: { user: { id: 123 } }, status: 'ok' } },
    expect: { state: 'UNKNOWN', signal: null },
  },
  {
    name: 'network error',
    candidate: 'whatever',
    obs: { error: 'fetch failed: TypeError' },
    expect: { state: 'UNKNOWN', signal: null },
  },
];

// Canary contract fixtures: (takenResult, randomResult) -> ok?
const HH_CANARY_FIXTURES = [
  {
    name: 'canary passes when taken=TAKEN and random=AVAILABLE',
    taken: { state: 'TAKEN', reason: '' },
    random: { state: 'AVAILABLE', reason: '' },
    expectOk: true,
  },
  {
    name: 'canary fails when known-taken comes back AVAILABLE',
    taken: { state: 'AVAILABLE', reason: 'x' },
    random: { state: 'AVAILABLE', reason: '' },
    expectOk: false,
  },
  {
    name: 'canary fails when random string comes back TAKEN',
    taken: { state: 'TAKEN', reason: '' },
    random: { state: 'TAKEN', reason: 'x' },
    expectOk: false,
  },
  {
    name: 'canary fails on UNKNOWNs (e.g. logged out / rate limited)',
    taken: { state: 'UNKNOWN', reason: 'auth required' },
    random: { state: 'UNKNOWN', reason: 'auth required' },
    expectOk: false,
  },
];

if (typeof globalThis !== 'undefined') {
  globalThis.HH_FIXTURES = HH_FIXTURES;
  globalThis.HH_CANARY_FIXTURES = HH_CANARY_FIXTURES;
}
