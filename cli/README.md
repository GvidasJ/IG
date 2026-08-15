# Handle Hunter — console version

A terminal script that checks Instagram username **availability** honestly, for
people who prefer a command line over the browser extension.

**Read this first:** the browser extension (in the repo root) is the better
tool. It runs inside your real browser, so Instagram treats it like you
clicking around, and it also does the "can I actually register it?" signup
check. This script sends requests from outside the browser, so **Instagram
rate-limits it sooner**, and it only checks availability. Use it only if you
specifically want a terminal tool.

## What it fixes vs. the naive script

The Python script you (or ChatGPT) probably tried checks
`instagram.com/<name>` while **logged out**. Instagram redirects *every* name —
free or taken — to a login wall, so it reports free names (and random nonsense)
as **TAKEN**. That's why it looked like everything was taken, and why a
**VPN/proxy did nothing** — the problem was never your IP.

This script uses your **logged-in session cookie** against Instagram's real
profile API, so it gives three honest answers: `AVAILABLE`, `TAKEN`, `UNKNOWN`.
It runs a canary first (a known-taken handle must read TAKEN, a random string
must read AVAILABLE) and aborts if that fails, so it can't hand you a wrong
list.

## What it will NOT do

- **No proxies, no IP rotation, no evasion.** On a rate-limit it stops and tells
  you to wait. Rotating IPs to push through is against Instagram's rules and
  gets accounts/IPs banned — there is no safe "secret" for this.
- **It cannot go faster than Instagram allows.** Same account = same limits as
  the extension. No tool legitimately beats the rate limit.
- You do **not** need to check thousands of names. Most longer/3-word combos
  are free — put a few dozen you actually like in `usernames.txt` and pick a
  green one.

## Run it

1. Log in to instagram.com in your browser (normal window).
2. Copy two cookies — DevTools (F12) → Application → Cookies →
   `www.instagram.com` → copy the values of **`sessionid`** and **`csrftoken`**.
   (These are your own cookies; the script never sees your password.)
3. Set them as environment variables:
   - macOS/Linux: `export IG_SESSIONID='...'` and `export IG_CSRFTOKEN='...'`
   - Windows PowerShell: `$env:IG_SESSIONID='...'` and `$env:IG_CSRFTOKEN='...'`
4. Put candidates in `cli/usernames.txt`, one per line.
5. `python3 cli/handle_hunter.py`

Results stream live in the terminal (green = available) and save to
`results.csv`. No dependencies — standard-library Python 3 only.
