// content.js — runs on instagram.com pages. This is deliberately dumb:
// it performs a same-origin fetch when the background asks, and reports the
// raw observation back. All classification lives in detector.js (background).
// It never reads credentials, never touches the DOM of the logged-in session
// beyond existing on the page, and never fires a request on its own.

'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'HH_PING') return;
  sendResponse({ ok: true, alive: true });
});
