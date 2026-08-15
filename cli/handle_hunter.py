#!/usr/bin/env python3
"""
handle_hunter.py — honest, rate-limited Instagram username availability checker.

This is the SAME honest method the Handle Hunter browser extension uses, just
in a console script. It is NOT the naive status-code approach that reports
garbage.

WHY THE NAIVE SCRIPT LIES (and why a VPN/proxy does NOT fix it):
  Logged OUT, https://www.instagram.com/<name>/ redirects EVERY name — taken or
  free — to a login wall. A status-code check reads that redirect as "taken,"
  so free names show TAKEN and random nonsense shows TAKEN too. The problem is
  never your IP, so changing it with a VPN/proxy changes nothing. The fix is to
  use your LOGGED-IN session against Instagram's real profile API, which gives
  three honest answers.

WHAT THIS DOES NOT DO (on purpose):
  * No proxies, no IP rotation, no evasion. If Instagram rate-limits you, it
    STOPS and tells you to wait. Rotating IPs to get around that is against
    Instagram's rules and gets accounts/IPs permanently banned.
  * It does NOT go faster than Instagram allows. Same account = same limits as
    the extension. No legitimate tool beats the rate limit; the wall is on
    Instagram's side, tied to you, not to the code.

HONEST LIMITATIONS vs the extension:
  * The extension runs inside your real browser, so it looks like you clicking
    around. This script sends requests from outside the browser, which
    Instagram flags a bit sooner — so it may rate-limit FASTER than the
    extension. The extension is the safer tool. Use this only if you prefer a
    terminal.
  * This checks AVAILABILITY (does a profile exist). The "can I actually
    register it" signup check is left to the extension — that call needs live
    page tokens that are impractical to reproduce reliably in a plain script.

USAGE:
  1. Log in to instagram.com in your browser (normal, not incognito).
  2. Copy two cookies (DevTools -> Application -> Cookies -> www.instagram.com):
       sessionid   and   csrftoken
     Set them as environment variables (recommended — keeps them out of the
     file):
         export IG_SESSIONID='...'     (Windows PowerShell: $env:IG_SESSIONID='...')
         export IG_CSRFTOKEN='...'
     or paste them into the CONFIG block below.
  3. Put candidate usernames in usernames.txt (one per line).
  4. python3 handle_hunter.py

  These are YOUR OWN cookies from YOUR OWN session — the script never asks for
  your password and never sends anything anywhere except Instagram.
"""

import csv
import json
import os
import random
import re
import string
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

# ------------------------------- CONFIG --------------------------------------

# Paste cookies here OR (better) set env vars IG_SESSIONID / IG_CSRFTOKEN.
SESSIONID = os.environ.get("IG_SESSIONID", "")
CSRFTOKEN = os.environ.get("IG_CSRFTOKEN", "")

RATE_SECONDS = 4.0        # seconds between requests (>= 1). Slower = safer.
JITTER_FRAC = 0.5         # extra random delay, as a fraction of RATE_SECONDS.
# Input file: pass a path as the first argument, else it looks for
# usernames.txt in the current folder AND next to this script (cli/).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = (sys.argv[1] if len(sys.argv) > 1 else None)
OUTPUT_CSV = "results.csv"

# Instagram's own web app id, sent with this public web API call. Not spoofing:
# the request is your real logged-in session.
IG_APP_ID = "936619743392459"
API = "https://www.instagram.com/api/v1/users/web_profile_info/?username={}"

# ------------------------------- COLORS --------------------------------------

class C:
    GREEN = "\033[92m"; GREY = "\033[90m"; AMBER = "\033[93m"
    RED = "\033[91m"; BOLD = "\033[1m"; DIM = "\033[2m"; END = "\033[0m"

def color_state(state):
    return {"AVAILABLE": C.GREEN, "TAKEN": C.GREY, "UNKNOWN": C.AMBER}.get(state, "") + state + C.END

# ----------------------------- VALIDATION ------------------------------------

VALID_RE = re.compile(r"^[a-z0-9._]+$")

def normalize(raw):
    return raw.strip().lstrip("@").lower()

def validate(h):
    """Instagram handle rules. Returns (ok, reason)."""
    if not h:
        return False, "empty"
    if len(h) > 30:
        return False, "longer than 30 chars"
    if not VALID_RE.match(h):
        return False, "invalid characters (a-z 0-9 . _ only)"
    if h.startswith(".") or h.endswith("."):
        return False, "leading/trailing period"
    if ".." in h:
        return False, "consecutive periods"
    return True, ""

# ------------------------------ THE CHECK ------------------------------------

class RateLimited(Exception):
    pass

class LoggedOut(Exception):
    pass

def fetch(username):
    """Return (status_code, parsed_json_or_None, raw_text)."""
    req = urllib.request.Request(
        API.format(urllib.parse.quote(username)),
        headers={
            "x-ig-app-id": IG_APP_ID,
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/120.0 Safari/537.36"),
            "Cookie": f"sessionid={SESSIONID}; csrftoken={CSRFTOKEN}",
            "x-csrftoken": CSRFTOKEN,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, _try_json(body), body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return e.code, _try_json(body), body
    except Exception as e:  # network error
        return None, None, str(e)

def _try_json(text):
    try:
        return json.loads(text)
    except Exception:
        return None

def classify(username, status, data, raw):
    """
    Three honest states. AVAILABLE and TAKEN require a POSITIVE signal;
    anything ambiguous is UNKNOWN. Mirrors the extension's detector.js.
    Raises RateLimited / LoggedOut so the caller can STOP the run.
    """
    msg = ""
    if isinstance(data, dict) and isinstance(data.get("message"), str):
        msg = data["message"]

    if status == 429 or re.search(r"wait a few minutes", msg, re.I):
        raise RateLimited(f"HTTP {status}: {msg or 'rate limited'}")
    if status in (401, 403) or (isinstance(data, dict) and data.get("require_login")):
        raise LoggedOut(f"HTTP {status}: {msg or 'login required'} — check your sessionid cookie")

    # Positive TAKEN: 200 with a real user object whose username matches.
    if status == 200 and isinstance(data, dict):
        user = (data.get("data") or {}).get("user", "MISSING")
        if user is None:
            return "AVAILABLE", "API reports no such user"
        if isinstance(user, dict) and isinstance(user.get("username"), str):
            if user["username"].lower() == username.lower():
                return "TAKEN", "API returned the account"
            return "UNKNOWN", f'API returned a different account "{user["username"]}"'
        # 200 but not a shape we recognize -> never guess.
        return "UNKNOWN", "unrecognized 200 response shape"

    # Positive AVAILABLE: 404 (profile does not exist).
    if status == 404:
        return "AVAILABLE", "profile API returned 404"

    return "UNKNOWN", f"HTTP {status}"

# ------------------------------- CANARY --------------------------------------

def random_handle():
    return "hh" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(22))

def run_canary():
    """
    Before checking your list, prove the detector works RIGHT NOW:
      - a known-taken handle ("instagram") must classify TAKEN
      - a long random string must classify AVAILABLE
    If either fails, ABORT — better no list than a wrong one.
    """
    print(f"{C.BOLD}Canary check (proving the checker works before trusting it)...{C.END}")
    taken_h = "instagram"
    free_h = random_handle()
    for h, want in ((taken_h, "TAKEN"), (free_h, "AVAILABLE")):
        status, data, raw = fetch(h)
        state, reason = classify(h, status, data, raw)  # may raise -> handled in main
        got = "OK" if state == want else "FAIL"
        col = C.GREEN if state == want else C.RED
        print(f"  {col}{got}{C.END}  @{h[:24]:<24} -> {color_state(state)}  (expected {want})")
        if state != want:
            print(f"{C.RED}{C.BOLD}CANARY FAILED{C.END} — the checker is not classifying correctly right "
                  f"now (Instagram may have changed something, or you're logged out). Aborting so it "
                  f"can't produce a wrong list.\n  raw: {raw[:200]}")
            return False
        time.sleep(delay())
    print(f"{C.GREEN}Canary passed.{C.END}\n")
    return True

# -------------------------------- LOOP ---------------------------------------

def delay():
    return max(1.0, RATE_SECONDS) * (1 + random.random() * max(0.0, JITTER_FRAC))

def resolve_input():
    """Find usernames.txt: explicit arg, then cwd, then next to the script."""
    candidates = []
    if INPUT_FILE:
        candidates.append(INPUT_FILE)
    else:
        candidates += ["usernames.txt", os.path.join(_SCRIPT_DIR, "usernames.txt")]
    for p in candidates:
        if os.path.exists(p):
            return p
    print(f"{C.RED}No usernames.txt found.{C.END} Looked in: {', '.join(candidates)}\n"
          f"Create it (one username per line), or pass a path: "
          f"python3 cli/handle_hunter.py path/to/list.txt")
    sys.exit(1)

def load_candidates(path):
    if not os.path.exists(path):
        print(f"{C.RED}No {path} found.{C.END} Create it with one username per line.")
        sys.exit(1)
    seen, valid, rejected = set(), [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.lstrip().startswith("#"):
                continue
            h = normalize(line)
            if not h or h in seen:
                continue
            seen.add(h)
            ok, reason = validate(h)
            (valid if ok else rejected).append(h if ok else (h, reason))
    return valid, rejected

def main():
    if not SESSIONID or not CSRFTOKEN:
        print(f"{C.RED}Missing cookies.{C.END} Set IG_SESSIONID and IG_CSRFTOKEN "
              f"(see the instructions at the top of this file).")
        sys.exit(1)

    valid, rejected = load_candidates(resolve_input())
    if rejected:
        print(f"{C.DIM}Skipped {len(rejected)} invalid handle(s) (bad format).{C.END}")
    if not valid:
        print("Nothing valid to check.")
        sys.exit(0)

    print(f"Checking {C.BOLD}{len(valid)}{C.END} handle(s) at ~1 request / {RATE_SECONDS:g}s "
          f"(+jitter). Press Ctrl+C to stop.\n")

    try:
        if not run_canary():
            sys.exit(2)
    except (RateLimited, LoggedOut) as e:
        print(f"{C.RED}Canary could not run: {e}{C.END}")
        sys.exit(2)

    rows = []
    try:
        for i, h in enumerate(valid, 1):
            status, data, raw = fetch(h)
            try:
                state, reason = classify(h, status, data, raw)
            except RateLimited as e:
                print(f"\n{C.AMBER}{C.BOLD}PAUSED — Instagram is rate-limiting ({e}).{C.END}\n"
                      f"Wait 20-30 minutes, then run again. Do NOT switch on a VPN/proxy to "
                      f"push through — that risks your account. Already-checked results are saved.")
                break
            except LoggedOut as e:
                print(f"\n{C.RED}{C.BOLD}STOPPED — you appear to be logged out ({e}).{C.END}\n"
                      f"Refresh your sessionid cookie and run again.")
                break

            rows.append((h, state, reason))
            print(f"[{i:>4}/{len(valid)}] {h:<30} {color_state(state)}"
                  + (f"  {C.DIM}{reason}{C.END}" if state == "UNKNOWN" else ""))
            if i < len(valid):
                time.sleep(delay())
    except KeyboardInterrupt:
        print(f"\n{C.DIM}Stopped by you.{C.END}")

    # Save whatever we have.
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["handle", "state", "reason"])
        w.writerows(rows)

    avail = [h for h, s, _ in rows if s == "AVAILABLE"]
    print(f"\n{C.BOLD}Done.{C.END} {len(rows)} checked, "
          f"{C.GREEN}{len(avail)} AVAILABLE{C.END}. Saved to {OUTPUT_CSV}.")
    if avail:
        print(f"\n{C.GREEN}{C.BOLD}Worth trying at signup{C.END} (verify in the app — Instagram "
              f"reserves some names that look free):")
        for h in avail:
            print(f"  {C.GREEN}@{h}{C.END}")


if __name__ == "__main__":
    main()
