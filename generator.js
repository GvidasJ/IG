// generator.js — candidate handle generation. Pure local JS: no API calls,
// no network, works offline against the bundled wordlist.js. Every generator
// returns handles already passed through HHValidation, so nothing invalid can
// reach the queue from here.

'use strict';

const HHGenerator = (() => {
  const VOWELS = 'aeiou';
  // Weighted consonants: common, friendly onsets first. No q (needs u), rare x.
  const CONSONANTS = 'nnmmrrssttllkkddbbppvvzzffggjhwcy';
  // Pronounceable final clusters for the CVCC pattern (narv, kelt, rusk...).
  const CODAS = ['st', 'nd', 'nt', 'rk', 'rn', 'rt', 'lt', 'sk', 'sh', 'th', 'ch', 'ck', 'mp', 'ng', 'lf', 'rv', 'lm', 'x', 'z'];
  // Consonant clusters that read okay without vowels (krsh, blvd, strn...).
  const CLUSTER_START = ['kr', 'br', 'bl', 'tr', 'dr', 'gr', 'st', 'str', 'sk', 'sl', 'sn', 'sm', 'pr', 'pl', 'kl', 'fr', 'fl', 'vr', 'zv', 'thr'];
  const CLUSTER_END = ['sh', 'rk', 'st', 'nd', 'rn', 'lv', 'vd', 'x', 'z', 'th', 'ng', 'nt'];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function words({ minLen = 3, maxLen = 8 } = {}) {
    return HH_WORDS.filter((w) => w.length >= minLen && w.length <= maxLen);
  }

  // Dedupe + validate + cap. Every public generator funnels through this.
  function finish(list, cap = Infinity) {
    const { valid } = HHValidation.filterList(list);
    return valid.slice(0, cap);
  }

  // ---- 1. Phonetic (CVCV / CVC / CVCC and longer) -----------------------

  function phoneticOne(pattern) {
    let s = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === 'v') s += pick(VOWELS);
      else if (ch === 'C') s += pick(CODAS); // trailing cluster slot
      else s += pick(CONSONANTS);
    }
    return s;
  }

  // pattern: one of 'cvc', 'cvcv', 'cvcC' (C = final cluster), 'cvcvc', 'vcvc', 'cvcvcv'
  function phonetic({ pattern = 'cvcv', count = 50 } = {}) {
    const out = new Set();
    for (let tries = 0; out.size < count && tries < count * 30; tries++) {
      out.add(phoneticOne(pattern));
    }
    return finish([...out], count);
  }

  // ---- 2. Real word + affix ---------------------------------------------

  const AFFIX_TEMPLATES = ['{w}', '{w}hq', 'the{w}', '{w}.co', '{w}ly'];

  function wordAffix({ templates = AFFIX_TEMPLATES, minLen = 3, maxLen = 6, count = 50, mustContain = '' } = {}) {
    let pool = words({ minLen, maxLen });
    if (mustContain) {
      const seed = mustContain.toLowerCase().replace(/[^a-z]/g, '');
      pool = pool.filter((w) => w.includes(seed));
      // The typed word counts as a word even if the bundled list lacks it.
      if (seed.length >= 2 && !pool.includes(seed)) pool.push(seed);
    }
    const out = new Set();
    for (let tries = 0; out.size < count && tries < count * 30 && pool.length; tries++) {
      out.add(pick(templates).replace('{w}', pick(pool)));
    }
    return finish([...out], count);
  }

  // ---- 3. Portmanteau ---------------------------------------------------
  // Blend two supplied words at vowel-boundary seams: prefix of A ending in a
  // vowel group + suffix of B starting at a vowel group (and the reverse mix),
  // which tends to produce natural-sounding joins (breakfast+lunch -> brunch).

  function seamsAfterVowelGroup(w) {
    const idx = [];
    for (let i = 0; i < w.length - 1; i++) {
      if (VOWELS.includes(w[i]) && !VOWELS.includes(w[i + 1])) idx.push(i + 1);
    }
    return idx;
  }
  function seamsAtVowelStart(w) {
    const idx = [];
    for (let i = 1; i < w.length; i++) {
      if (VOWELS.includes(w[i]) && !VOWELS.includes(w[i - 1])) idx.push(i);
    }
    return idx;
  }

  function portmanteau({ wordA = '', wordB = '' } = {}) {
    const a = HHValidation.normalize(wordA).replace(/[^a-z]/g, '');
    const b = HHValidation.normalize(wordB).replace(/[^a-z]/g, '');
    if (a.length < 2 || b.length < 2) return [];
    const out = new Set();
    for (const [x, y] of [[a, b], [b, a]]) {
      for (const i of seamsAfterVowelGroup(x)) {
        for (const j of seamsAtVowelStart(y)) {
          const cand = x.slice(0, i) + y.slice(j);
          if (cand.length >= 3 && cand.length <= 12 && cand !== x && cand !== y) out.add(cand);
        }
        // also seam directly onto y's tail consonants (zeva+narv -> zerv style)
        const tail = y.slice(-Math.min(3, y.length - 1));
        const cand2 = x.slice(0, i) + tail;
        if (cand2.length >= 3 && cand2.length <= 12) out.add(cand2);
      }
    }
    return finish([...out].sort((p, q) => p.length - q.length), 100);
  }

  // ---- 4. Doubled letters -----------------------------------------------
  // mattt, hooop: repeat one letter 2–3 extra times, or stretch the last one.

  function doubled({ base = '', count = 60 } = {}) {
    const src = base
      ? [HHValidation.normalize(base).replace(/[^a-z0-9._]/g, '')]
      : null;
    const out = new Set();
    const addVariants = (w) => {
      if (!w || w.length < 2) return;
      for (let i = 0; i < w.length; i++) {
        if (!/[a-z]/.test(w[i])) continue;
        out.add(w.slice(0, i + 1) + w[i] + w.slice(i + 1));         // one extra
        out.add(w.slice(0, i + 1) + w[i] + w[i] + w.slice(i + 1));  // two extra
      }
    };
    if (src) src.forEach(addVariants);
    else {
      const pool = words({ minLen: 3, maxLen: 5 });
      for (let tries = 0; out.size < count && tries < count * 5; tries++) addVariants(pick(pool));
    }
    return finish([...out], count);
  }

  // ---- 5. No-vowel / consonant clusters ---------------------------------
  // Two flavors, mixed: real words with vowels stripped (boulevard -> blvrd
  // family) and synthetic pronounceable-adjacent clusters (krsh).

  function novowel({ length = 4, count = 50 } = {}) {
    const out = new Set();
    const pool = words({ minLen: length + 1, maxLen: length + 5 });
    for (let tries = 0; out.size < count / 2 && tries < count * 20; tries++) {
      const stripped = pick(pool).replace(/[aeiou]/g, '');
      if (stripped.length === length) out.add(stripped);
    }
    for (let tries = 0; out.size < count && tries < count * 20; tries++) {
      const start = pick(CLUSTER_START);
      const end = pick(CLUSTER_END);
      let mid = '';
      while (start.length + mid.length + end.length < length) mid += pick('rlnmsvztkd');
      const cand = start + mid + end;
      if (cand.length === length) out.add(cand);
    }
    return finish([...out], count);
  }

  // ---- 6. Character swaps on a base handle ------------------------------
  // Dots, underscores, and letter->number swaps of a handle you want but
  // can't have. All output re-validated (no leading/trailing/double dots).

  const LEET = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', b: '8', g: '9', l: '1' };

  function swaps({ base = '' } = {}) {
    const w = HHValidation.normalize(base).replace(/[^a-z0-9._]/g, '');
    if (w.length < 2) return [];
    const out = new Set();

    // separators inserted at each internal position
    for (let i = 1; i < w.length; i++) {
      for (const sep of ['.', '_']) {
        out.add(w.slice(0, i) + sep + w.slice(i));
      }
    }
    // underscore wrapping
    out.add('_' + w); out.add(w + '_'); out.add('_' + w + '_');
    out.add('__' + w); out.add(w + '__');
    // single leet swap per position
    for (let i = 0; i < w.length; i++) {
      const sub = LEET[w[i]];
      if (sub) out.add(w.slice(0, i) + sub
        + w.slice(i + 1));
    }
    // full leet
    out.add(w.split('').map((c) => LEET[c] || c).join(''));
    // doubled last letter + separator combos
    out.add(w + w[w.length - 1]);
    for (let i = 1; i < w.length; i++) {
      out.add(w.slice(0, i) + '.' + w.slice(i) + w[w.length - 1]);
    }
    out.delete(w);
    return finish([...out], 200);
  }

  // ---- 7. Brute-force sweep (gated in the UI) ---------------------------
  // Lexicographic enumeration with an offset so a sweep can continue across
  // sessions. total() is used by the UI to show projected wall-clock time
  // BEFORE anything is queued — a full 4-letter a-z sweep at the default rate
  // is on the order of days, and the UI must say so.

  function sweepAlphabet(kind) {
    return kind === 'alnum' ? 'abcdefghijklmnopqrstuvwxyz0123456789' : 'abcdefghijklmnopqrstuvwxyz';
  }

  function sweepTotal({ alphabet = 'letters', length = 4, prefix = '' } = {}) {
    const n = Math.max(0, length - HHValidation.normalize(prefix).length);
    return Math.pow(sweepAlphabet(alphabet).length, n);
  }

  function sweep({ alphabet = 'letters', length = 4, prefix = '', offset = 0, limit = 500 } = {}) {
    const alpha = sweepAlphabet(alphabet);
    const p = HHValidation.normalize(prefix).replace(/[^a-z0-9._]/g, '');
    const n = length - p.length;
    if (n < 0) return { candidates: [], total: 0 };
    if (n === 0) return { candidates: finish([p]), total: 1 };
    const total = Math.pow(alpha.length, n);
    const out = [];
    for (let k = offset; k < total && out.length < limit; k++) {
      let s = '', rem = k;
      for (let d = 0; d < n; d++) {
        s = alpha[rem % alpha.length] + s;
        rem = Math.floor(rem / alpha.length);
      }
      out.push(p + s);
    }
    return { candidates: finish(out, limit), total, nextOffset: Math.min(offset + out.length, total) };
  }

  return { phonetic, wordAffix, portmanteau, doubled, novowel, swaps, sweep, sweepTotal, AFFIX_TEMPLATES };
})();

if (typeof globalThis !== 'undefined') globalThis.HHGenerator = HHGenerator;
