// content.js — runs on instagram.com pages. This is deliberately dumb:
// it performs a same-origin fetch when the background asks, and reports the
// raw observation back. All classification lives in detector.js (background),
// so Instagram changes are fixed there without touching this file.
// It never reads credentials, never fires a request on its own, and adds no
// headers beyond what the background hands it (the site's own API app id).

'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'HH_PING' && msg.type !== 'HH_FETCH')) return;

  if (msg.type === 'HH_PING') {
    sendResponse({ ok: true, alive: true });
    return;
  }

  // HH_FETCH: { url, headers, method?, body?, needsCsrf? } -> raw observation.
  doFetch(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message || err) }));
  return true; // async response
});

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// Scrape the page's LSD token (a per-session anti-CSRF token Instagram embeds
// in its bootstrap JSON). Present on any instagram.com page. We read it from
// the current document; if not found, fetch a fresh page and read it there.
function extractLsd(html) {
  const pats = [
    /\["LSD",\[\],\{"token":"([^"]+)"\}/,
    /"lsd":\s*"([^"]+)"/,
    /name=\\?"lsd\\?"\s+value=\\?"([^"\\]+)/,
  ];
  for (const p of pats) { const m = html.match(p); if (m && m[1]) return m[1]; }
  return '';
}

// jazoest = "2" + sum of char codes of the lsd token (kept in sync with
// HHSignup.jazoest; content.js can't importScripts, so it's inlined).
function deriveJazoest(token) {
  let sum = 0;
  for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i);
  return '2' + sum;
}

// Scrape the build/session params Instagram's own GraphQL POSTs carry. Without
// them Meta rejects the call with error 1357004 ("close and reopen your
// browser"). All are embedded in the page's bootstrap JSON.
function extractBootstrap(html) {
  const one = (re) => { const m = html.match(re); return m ? m[1] : ''; };
  return {
    lsd: extractLsd(html),
    rev: one(/"__spin_r":(\d+)/) || one(/"client_revision":(\d+)/) || one(/"rev":(\d+)/),
    spinB: one(/"__spin_b":"([^"]+)"/) || 'trunk',
    spinT: one(/"__spin_t":(\d+)/),
    hs: one(/"__hs":"([^"]+)"/) || one(/"haste_session":"([^"]+)"/),
  };
}

// Read from the current page; if the essentials (lsd + rev) aren't there,
// fetch a fresh page and merge what it has.
async function getBootstrap() {
  let bp = extractBootstrap(document.documentElement.innerHTML);
  if (bp.lsd && bp.rev) return bp;
  try {
    const r = await fetch('/accounts/emailsignup/', { credentials: 'same-origin' });
    const fresh = extractBootstrap(await r.text());
    for (const k of Object.keys(fresh)) if (!bp[k] && fresh[k]) bp[k] = fresh[k];
  } catch { /* ignore */ }
  return bp;
}

async function doFetch({ url, headers = {}, method = 'GET', body = null, needsCsrf = false, needsLsd = false }) {
  // Same-origin guard: this script only ever talks to instagram.com.
  if (!/^https:\/\/www\.instagram\.com\//.test(url)) {
    return { error: `refusing non-Instagram URL: ${url}` };
  }

  const finalHeaders = { ...headers };
  if (needsCsrf) {
    // csrftoken is a normal (non-httpOnly) cookie readable in page context;
    // Instagram requires it echoed back as a header on POSTs. This is the
    // user's own token from their own session — no credential handling.
    const token = readCookie('csrftoken');
    if (!token) {
      return { error: 'no csrftoken cookie — are you logged in to instagram.com?' };
    }
    finalHeaders['x-csrftoken'] = token;
  }
  if (needsLsd) {
    const bp = await getBootstrap();
    if (!bp.lsd) return { error: 'could not find an LSD token on the page — reload instagram.com' };
    finalHeaders['x-fb-lsd'] = bp.lsd;
    // Build/session params the real page sends; omit any we couldn't scrape.
    const dyn = [
      'av=0', '__d=www', '__user=0', '__a=1', '__req=1', 'dpr=1', '__ccg=EXCELLENT', '__comet_req=7',
      bp.rev ? `__rev=${bp.rev}` : null,
      bp.rev ? `__spin_r=${bp.rev}` : null,
      bp.spinB ? `__spin_b=${encodeURIComponent(bp.spinB)}` : null,
      bp.spinT ? `__spin_t=${bp.spinT}` : null,
      bp.hs ? `__hs=${encodeURIComponent(bp.hs)}` : null,
    ].filter(Boolean).join('&');
    if (typeof body === 'string') {
      body = body
        .replace('__DYNPARAMS__', dyn)
        .replace('__LSD__', bp.lsd)
        .replace('__JAZOEST__', deriveJazoest(bp.lsd));
    }
  }

  let resp;
  try {
    resp = await fetch(url, {
      method,
      credentials: 'same-origin', // the user's existing session cookie, nothing else
      redirect: 'follow',
      headers: finalHeaders,
      body: method === 'GET' ? undefined : body,
    });
  } catch (err) {
    return { error: `fetch failed: ${String(err && err.message || err)}` };
  }

  let bodyText = '';
  try {
    bodyText = await resp.text();
  } catch (err) {
    return {
      status: resp.status,
      finalUrl: resp.url,
      contentType: resp.headers.get('content-type') || '',
      error: `body read failed: ${String(err && err.message || err)}`,
    };
  }

  // Meta prefixes JSON with `for (;;);` as anti-hijacking; strip it before parse.
  let json = null;
  const cleaned = bodyText.replace(/^\s*for\s*\(;;\);/, '');
  try { json = JSON.parse(cleaned); } catch { /* not JSON — detector handles it */ }

  return {
    status: resp.status,
    finalUrl: resp.url,
    contentType: resp.headers.get('content-type') || '',
    // Truncated: enough for the detector and for honest UNKNOWN reasons,
    // without hoarding whole HTML documents in memory/storage.
    bodyText: bodyText.slice(0, 4000),
    json,
  };
}
