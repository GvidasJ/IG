# Handle Hunter

A Chrome (Manifest V3) extension for finding a short, unusual, still-available
Instagram username — for yourself, at personal scale. It generates candidate
handles locally and checks availability from inside **your own logged-in
browser session**, slowly, with honest three-state results.

No build step, no framework, no bundler. Vanilla JS; edit the files directly.

## Load it (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Make sure you're **logged in to instagram.com** in a normal tab
5. Click the extension → **Dashboard ↗** for the full page, or use the popup
   for a quick single check

On the first run of any session, the extension checks its canary (see below)
before touching your list. It will open a background tab on instagram.com if
none exists — that tab is where the checks actually run; leave it open.

## What the states mean

| State | Meaning |
|---|---|
| 🟢 `AVAILABLE` | The API positively reported no such user. **Worth trying at signup — not a guarantee**: Instagram reserves/blocks some names that look free. |
| ⚪ `TAKEN` | The API positively returned the account. |
| 🟡 `UNKNOWN` | Anything ambiguous — rate-limited, logged out, interstitial, unrecognized response. The raw reason is shown in the row. Re-check gives it one manual retry. |

`UNKNOWN` is never collapsed into the other two. A checker that says UNKNOWN
honestly is useful; one that says TAKEN wrongly is worse than nothing.

## Availability vs. registerability (the Signup column)

`AVAILABLE` answers "does an account exist at this name?" — nothing more.
Instagram **reserves or retires** huge numbers of names that have no profile:
essentially all 1–3 character names, deleted/banned accounts, trademarks, and
names it simply holds. Those read `AVAILABLE` here yet can never be registered.

The **Signup** column closes that gap. Click **Verify** on a green row and the
extension asks Instagram's real signup username-validator (the same call the
signup form makes as you type):

- 🟢 `REGISTERABLE` — the signup validator accepted the username.
- ⚪ `BLOCKED` — reserved/taken/invalid at signup, even if no profile exists.

This is deliberately **one manual click per name — never bulk**. That endpoint
is the most abuse-monitored on the site, so the tool refuses to automate it at
scale; you verify only your handful of finalists. The request is built to
**never create an account** (empty email + unusable password), and it has its
own canary (`@instagram` must come back `BLOCKED`, a random string
`REGISTERABLE`) — if that fails, the verdict is not trusted and the banner
shows the raw response. All of this lives isolated in `signup.js`.

If the signup canary fails in your browser, capture the real request (DevTools
→ Network, while typing a username into
`instagram.com/accounts/emailsignup/`) and point `signup.js` at exactly what
your browser sends — same pattern as fixing `detector.js`.

## Deliberate limits (not bugs)

- **Hard cap of 500 candidates per run** and **1 request every 4 seconds plus
  jitter** (jitter only ever adds delay). Both are configurable in the
  dashboard, behind a warning — the defaults are the intended operating point.
- **On any rate-limit / logged-out / challenge response the whole queue stops**
  with a banner and exponential backoff advice (5 → 10 → 20 → … minutes).
  Resume is always manual. There is no automatic retry anywhere.
- **No evasion.** No proxies, no IP or user-agent games, no CAPTCHA handling.
  If Instagram pushes back, the tool backs off and tells you.
- **No credentials.** It rides the session cookie already in your browser; if
  you're logged out it says so and pauses.
- **Nothing leaves your machine.** No analytics, no servers. All state is in
  `chrome.storage.local`; the word list is bundled.
- The queue survives popup closes, service-worker death, and browser restarts
  (after a restart it parks itself paused with progress intact — press
  Resume). Handles already resolved are never silently re-checked.

## When results go wrong, fix `detector.js` first

All Instagram-specific knowledge — the endpoint, the response shapes, the
classification rules — is isolated in **`detector.js`**. Instagram changes
these things. The layers around it (queue, content script, UI) don't encode
any Instagram behavior and almost never need touching.

Guardrails that tell you it's broken:

- **Canary check, every run:** before your list is processed, a hardcoded
  known-taken handle (`instagram`) and a fresh 24-char random string are
  checked. If they don't come back `TAKEN` and `AVAILABLE` respectively, the
  run **aborts loudly** and produces no results.
- **Detector self-test** (dashboard, left column): queues 5 famous handles and
  5 random strings so you can verify classification by hand.
- If 5 consecutive checks come back plain `UNKNOWN`, the run pauses itself and
  says the detector may be stale.

What was verified empirically at build time (2026-08-14, logged out): profile
HTML pages 302 to the login wall for taken and free names alike (this is why
naive status-code scripts produce garbage), and the web profile API returns
401 `require_login` anonymously. The logged-in response shapes the detector
relies on (user object = taken, explicit user-null / "User not found" = free)
are the ones Instagram's own web client consumes, but they could not be
re-verified from the build environment — the canary is the proof on your
machine. If the canary fails on first run, `detector.js` is where to look;
`tests/detector-test.html` (open directly in any browser) checks the
classification contract offline.

## Testing

- `tests/detector-test.html` — offline fixture tests for the classifier;
  open the file in a browser.
- `node tests/queue-sim.node.js` — full queue-engine simulation (mocked
  Chrome APIs + scripted Instagram responses): canary abort, rate-limit stop
  and backoff, manual resume, persistence semantics, UNKNOWN guard. Takes
  about a minute; the ≥1s/request floor is intentionally not bypassable even
  in tests.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; each permission justified in comments |
| `background.js` | service worker: message router, watchdog alarm, lifecycle |
| `queue.js` | queue engine: pacing, cap, canary gate, pause/backoff, persistence |
| `detector.js` | **all** availability classification rules + canary definition |
| `signup.js` | registerability check (signup validator) + its own canary |
| `content.js` | dumb same-origin fetcher/poster on instagram.com; no logic |
| `validation.js` | Instagram handle format rules; filters before queueing |
| `generator.js` | seven local candidate generators |
| `wordlist.js` | ~4,400 bundled common words (built from public-domain lists) |
| `popup.*` | quick status + single check |
| `options.*` | full dashboard |
