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

  // HH_FETCH: { url, headers } -> raw observation for detector.classify().
  doFetch(msg.url, msg.headers || {})
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message || err) }));
  return true; // async response
});

async function doFetch(url, headers) {
  // Same-origin guard: this script only ever talks to instagram.com.
  if (!/^https:\/\/www\.instagram\.com\//.test(url)) {
    return { error: `refusing non-Instagram URL: ${url}` };
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin', // the user's existing session cookie, nothing else
      redirect: 'follow',
      headers,
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
