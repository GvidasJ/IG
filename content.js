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

async function doFetch({ url, headers = {}, method = 'GET', body = null, needsCsrf = false }) {
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

  let json = null;
  try { json = JSON.parse(bodyText); } catch { /* not JSON — detector handles it */ }

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
