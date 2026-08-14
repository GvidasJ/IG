// validation.js — Instagram handle format rules. Candidates that fail these
// can never be registered, so they are filtered BEFORE entering the queue and
// never cost a request.
// Rules: 1–30 chars; a-z 0-9 . _ only (case-insensitive, we normalize to
// lowercase); no leading or trailing period; no consecutive periods.

'use strict';

const HHValidation = (() => {
  function normalize(raw) {
    return String(raw || '').trim().replace(/^@/, '').toLowerCase();
  }

  // -> { ok: true } | { ok: false, reason }
  function validate(handle) {
    if (!handle) return { ok: false, reason: 'empty' };
    if (handle.length > 30) return { ok: false, reason: 'longer than 30 chars' };
    if (!/^[a-z0-9._]+$/.test(handle)) return { ok: false, reason: 'invalid characters (a-z 0-9 . _ only)' };
    if (handle.startsWith('.') || handle.endsWith('.')) return { ok: false, reason: 'leading/trailing period' };
    if (handle.includes('..')) return { ok: false, reason: 'consecutive periods' };
    return { ok: true };
  }

  // Normalize, validate and dedupe a raw list (array or newline-separated
  // string). -> { valid: [handle], rejected: [{handle, reason}] }
  function filterList(raw) {
    const lines = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
    const seen = new Set();
    const valid = [];
    const rejected = [];
    for (const line of lines) {
      const h = normalize(line);
      if (!h) continue;
      if (seen.has(h)) continue;
      seen.add(h);
      const v = validate(h);
      if (v.ok) valid.push(h);
      else rejected.push({ handle: h, reason: v.reason });
    }
    return { valid, rejected };
  }

  return { normalize, validate, filterList };
})();

if (typeof globalThis !== 'undefined') globalThis.HHValidation = HHValidation;
