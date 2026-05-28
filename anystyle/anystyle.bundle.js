// AnyStyle JS — client-side reference parser. Port of inukshuk/anystyle.
//
// Original AnyStyle copyright (c) 2011-2023 Sylvester Keil
//   Licensed under BSD-2-Clause. See model/ANYSTYLE_LICENSE.
// Dictionary data from anystyle-data (BSD-2-Clause).
//
// This JS port is licensed under AGPL-3.0 (per the host project) for the
// non-AnyStyle portions; AnyStyle-derived portions retain their BSD-2-Clause
// terms — see NOTICE / ANYSTYLE_LICENSE.

(function (global, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    global.AnyStyle = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ───── strings.js ─────
// String utilities ported from lib/anystyle/utils.rb (StringUtils).
// JS Unicode property regexes (\p{Lu} etc.) require the `u` flag.

// Ruby's `String#scrub` returns the string with invalid byte sequences
// replaced. JS strings are UTF-16 so this isn't an exact analogue; we just
// drop unpaired surrogates.
function fixUTF16(s) {
  return s.replace(/[\uD800-\uDFFF]/g, '');
}

// scrub(s) — strip characters matching blacklist (default: anything that's
// not alphanumeric, plus L modifier chars).
function scrub(s, blacklist) {
  if (s == null) return '';
  s = fixUTF16(s);
  if (blacklist == null) blacklist = /[^\p{L}\p{N}]|\p{Lm}/gu;
  return s.replace(blacklist, '');
}

// transliterate(s) — NFKD-normalize then strip combining marks.
function transliterate(s) {
  if (s == null) return '';
  return s.normalize('NFKD').replace(/\p{M}/gu, '');
}

// canonize(s) — transliterate, scrub, lowercase. Used for the "alpha" form of
// a token throughout AnyStyle.
function canonize(s) {
  return scrub(transliterate(s)).toLowerCase();
}

// nnum(s, symbol='#') — replace every digit with `symbol`.
function nnum(s, symbol = '#') {
  return s.normalize('NFC').replace(/\d/g, symbol);
}

// display_chars — used in normalizers / refs splitting (not by features).
function displayChars(s) {
  return s
    .replace(/\t/g, '    ')
    .replace(/\p{Mn}|\p{Me}|\p{Cc}/gu, '')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\s+$/, '');
}


// ───── tokenize.js ─────
// Tokenization. Ports AnyStyle's parser defaults:
//   separator: /(?:\r?\n)+/        — between reference sequences
//   delimiter: /(\s|\p{Space_Separator})+|([！-､]|。|、)/u
//                                   — within a reference: split on whitespace,
//                                     OR keep CJK punctuation as standalone tokens.
//
// The delimiter has two alternatives:
//   group 1: pure whitespace → consumed (used as a separator)
//   group 2: CJK punctuation character → kept as its own token

const SEPARATOR = /(?:\r?\n)+/;

// Split one reference string into tokens.
// JS doesn't have Ruby's `String#split` with capture-keep-as-token semantics
// in a single regex; we walk the string manually to match Ruby's behavior.
function tokenizeRef(text) {
  const tokens = [];
  // Pattern matches either whitespace runs or a CJK punctuation char.
  const re = /(\s|\p{Zs})+|([！-､]|。|、)/gu;
  let lastEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) {
      tokens.push(text.slice(lastEnd, m.index));
    }
    if (m[2]) {
      // CJK punct — emit as its own token
      tokens.push(m[2]);
    }
    // whitespace runs (m[1]) are discarded
    lastEnd = re.lastIndex;
  }
  if (lastEnd < text.length) {
    tokens.push(text.slice(lastEnd));
  }
  return tokens.filter(t => t.length > 0);
}

// Split the input blob into reference sequences (array of arrays of tokens).
function tokenize(blob, opts = {}) {
  const sep = opts.separator || SEPARATOR;
  const refs = blob.split(sep).map(s => s.trim()).filter(s => s.length > 0);
  return refs.map(tokenizeRef);
}


// ───── dict.js ─────
// Dictionary lookup. Ports lib/anystyle/dictionary.rb.
//
// Wordlist data lives in model/dict.json (built by scripts/build_dict.js
// from anystyle-data's dict.txt.gz). Each word maps to a 4-bit mask:
//   bit 0 (1): name
//   bit 1 (2): place
//   bit 2 (4): publisher
//   bit 3 (8): journal

const TAG_BITS = { name: 1, place: 2, publisher: 4, journal: 8 };
const TAGS_ORDER = ['name', 'place', 'publisher', 'journal'];

class Dictionary {
  constructor(db) {
    this.db = db || {};
  }

  get(key) {
    return this.db[String(key)] | 0;
  }

  tags(key) {
    const v = this.get(key);
    return TAGS_ORDER.map(t => (v & TAG_BITS[t]) ? 'T' : 'F');
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.db, key);
  }

  static fromJSON(json) {
    return new Dictionary(typeof json === 'string' ? JSON.parse(json) : json);
  }
}


// ───── wapiti.js ─────
// Wapiti model loader + linear-chain CRF inference (Viterbi).
//
// Parses Wapiti's text-format .mod file (as shipped with AnyStyle's parser
// model). Format outline:
//
//   #mdl#TYPE#NFTR                       — model header (NFTR = #nonzero features)
//   #rdr#NPATTERN/NUNIGRAM/NBIGRAM       — reader: pattern counts
//   <LEN>:<TYPE>:<NAME=PATTERN>,         — NPATTERN lines (TYPE ∈ {*,u,b})
//   #qrk#NLBL                            — label quark (label table)
//   <LEN>:<LABEL>,                       — NLBL lines
//   #qrk#NOBS                            — observation quark (string table)
//   <LEN>:<OBSSTR>,                      — NOBS lines, each "*:NAME=VAL" or
//                                          "u:NAME=VAL" or just "*" for the
//                                          global bigram pattern
//   <ID>=<WEIGHT>                        — sparse weights, one nonzero per line
//
// Feature ID layout (the part that took digging):
//   IDs are keyed by *observation*, not by pattern. Each obs string allocates
//   L (= |labels|) unigram slots, plus L² bigram slots iff the obs string is
//   bigram-eligible (starts with "*:" or is exactly "*"). IDs are assigned in
//   declaration order of the obs table:
//     obs[0]: ids [0, L) unigram, [L, L+L²) bigram (if eligible), …
//     obs[1]: ids continue from there, …
//
//   For obs k with offset base_k:
//     unigram slot for label y:        base_k + y
//     bigram slot for prev=py, cur=y:  base_k + L + py * L + y    (bigram obs only)
//
// At inference time, each pattern, expanded at a token position, produces an
// observation string. Look it up in obsIdx → obs index k → offsets via
// obsBase[k] and obsKind[k].


const PATTERN_RE = /%([xX])\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/g;
const HEADER_RE = /^#mdl#(\d+)#(\d+)$/;
const READER_RE = /^#rdr#(\d+)\/(\d+)\/(\d+)$/;
const QUARK_RE = /^#qrk#(\d+)$/;

function loadModel(text) {
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let li = 0;

  const hdr = lines[li++];
  const mHdr = HEADER_RE.exec(hdr);
  if (!mHdr) throw new Error(`bad #mdl header: ${hdr}`);
  const modelType = +mHdr[1];
  const declaredNFeatures = +mHdr[2];

  const rdr = lines[li++];
  const mRdr = READER_RE.exec(rdr);
  if (!mRdr) throw new Error(`bad #rdr header: ${rdr}`);
  const nPatterns = +mRdr[1];
  const nUnigram = +mRdr[2];
  const nBigram = +mRdr[3];

  // patterns
  const patterns = new Array(nPatterns);
  for (let i = 0; i < nPatterns; i++) {
    patterns[i] = parsePatternLine(lines[li++]);
  }

  // label quark
  const lbls = readQuark(lines, li); li = lbls.next;
  // observation quark
  const obs = readQuark(lines, li); li = obs.next;

  const L = lbls.items.length;
  const NOBS = obs.items.length;

  // obs kind: 'b' if bigram-capable ("*" or "*:..."), 'u' otherwise.
  const obsKind = new Uint8Array(NOBS); // 0 = unigram-only, 1 = bigram-capable
  const obsBase = new Int32Array(NOBS); // global feature-ID base for this obs
  let cursor = 0;
  for (let k = 0; k < NOBS; k++) {
    const s = obs.items[k];
    obsBase[k] = cursor;
    if (s === '*' || s.startsWith('*:')) {
      obsKind[k] = 1;
      cursor += L + L * L;
    } else {
      obsKind[k] = 0;
      cursor += L;
    }
  }
  const totalFeatures = cursor;

  // weights
  const weights = new Float64Array(totalFeatures);
  let nonzero = 0;
  for (; li < lines.length; li++) {
    const ln = lines[li];
    if (!ln) continue;
    const eq = ln.indexOf('=');
    if (eq < 0) continue;
    const id = +ln.slice(0, eq);
    const w = +ln.slice(eq + 1);
    if (!Number.isFinite(id) || !Number.isFinite(w)) continue;
    if (id < 0 || id >= totalFeatures) {
      throw new Error(`feature ID ${id} out of range [0, ${totalFeatures})`);
    }
    weights[id] = w;
    if (w !== 0) nonzero++;
  }

  // Precompute obs index
  const obsIdx = new Map();
  for (let k = 0; k < NOBS; k++) obsIdx.set(obs.items[k], k);

  // Precompute label index
  const labelIdx = new Map();
  for (let i = 0; i < L; i++) labelIdx.set(lbls.items[i], i);

  return {
    modelType, declaredNFeatures,
    nPatterns, nUnigram, nBigram,
    patterns,
    labels: lbls.items, labelIdx,
    observations: obs.items, obsIdx,
    obsKind, obsBase,
    weights, totalFeatures,
    nonzero,
    L, NOBS,
  };
}

function readQuark(lines, li) {
  const hdr = lines[li];
  const m = QUARK_RE.exec(hdr);
  if (!m) throw new Error(`expected #qrk# at line ${li}, got: ${hdr}`);
  const n = +m[1];
  li++;
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    items[i] = decodeQuarkEntry(lines[li++]);
  }
  return { items, next: li };
}

// Decode a "LEN:STR," entry. LEN is byte length of STR in UTF-8.
// Strings cannot contain literal commas (Wapiti escapes them); for AnyStyle's
// model we trust the trailing-comma convention.
function decodeQuarkEntry(ln) {
  const colon = ln.indexOf(':');
  if (colon < 0) throw new Error(`bad quark entry: ${ln}`);
  let s = ln.slice(colon + 1);
  if (s.endsWith(',')) s = s.slice(0, -1);
  return s;
}

// One pattern line: "<LEN>:<TYPE>:<NAME=PATTERN>,"
// (TYPE is one of *,u,b ; for the global bigram template the body is just "*")
function parsePatternLine(ln) {
  const colon = ln.indexOf(':');
  if (colon < 0) throw new Error(`bad pattern line: ${ln}`);
  let body = ln.slice(colon + 1);
  if (body.endsWith(',')) body = body.slice(0, -1);
  return parsePatternBody(body);
}

function parsePatternBody(body) {
  if (body === '*' || body === '') {
    return { type: '*', name: '*', refs: [], literalParts: [''] , obsKey: '*' };
  }
  let type = 'u';
  let rest = body;
  if (body.length >= 2 && body[1] === ':' && /[*ub]/.test(body[0])) {
    type = body[0];
    rest = body.slice(2);
  }
  const eq = rest.indexOf('=');
  let name = rest;
  let patternStr = '';
  if (eq >= 0) {
    name = rest.slice(0, eq);
    patternStr = rest.slice(eq + 1);
  }
  const refs = [];
  const literalParts = [];
  let last = 0;
  PATTERN_RE.lastIndex = 0;
  let m;
  while ((m = PATTERN_RE.exec(patternStr)) !== null) {
    literalParts.push(patternStr.slice(last, m.index));
    refs.push({
      caseSensitive: m[1] === 'x',
      row: +m[2],
      col: +m[3],
    });
    last = m.index + m[0].length;
  }
  literalParts.push(patternStr.slice(last));

  // The "observation key" prefix used when looking up in the obs table:
  //   "<type>:<name>=" for normal patterns; just "<name>" for refless patterns
  //   (only the global "*" hits the latter, handled above).
  const obsKey = `${type}:${name}=`;
  return { type, name, refs, literalParts, obsKey };
}

// Expand a pattern at a given token position, producing the obs-table key
// string Wapiti would have emitted.
function expandObs(pattern, tokens, idx) {
  if (pattern.refs.length === 0) return pattern.obsKey; // '*'
  let out = pattern.obsKey;
  for (let i = 0; i < pattern.refs.length; i++) {
    out += pattern.literalParts[i];
    const r = pattern.refs[i];
    const rowIdx = idx + r.row;
    let val;
    if (rowIdx < 0) {
      val = `_x${r.row}`;
    } else if (rowIdx >= tokens.length) {
      val = `_x+${r.row}`;
    } else {
      const row = tokens[rowIdx];
      val = (r.col >= 0 && r.col < row.length) ? row[r.col] : '';
      if (r.caseSensitive === false) val = val.toLowerCase();
    }
    out += val;
  }
  out += pattern.literalParts[pattern.literalParts.length - 1];
  return out;
}

// Unigram emission vector at position idx — sum of weights from all unigram
// patterns whose expanded obs string is in the table.
function unigramScores(model, tokens, idx, out) {
  const L = model.L;
  if (!out) out = new Float64Array(L);
  else out.fill(0);
  const w = model.weights;
  for (let p = 0; p < model.patterns.length; p++) {
    const pat = model.patterns[p];
    if (pat.type !== 'u' && pat.type !== '*') continue;
    const obsStr = expandObs(pat, tokens, idx);
    const oid = model.obsIdx.get(obsStr);
    if (oid === undefined) continue;
    const base = model.obsBase[oid];
    for (let y = 0; y < L; y++) out[y] += w[base + y];
  }
  return out;
}

// Bigram transition matrix at position idx (L × L).
function bigramScores(model, tokens, idx, out) {
  const L = model.L;
  const L2 = L * L;
  if (!out) out = new Float64Array(L2);
  else out.fill(0);
  const w = model.weights;
  for (let p = 0; p < model.patterns.length; p++) {
    const pat = model.patterns[p];
    if (pat.type !== 'b' && pat.type !== '*') continue;
    const obsStr = expandObs(pat, tokens, idx);
    const oid = model.obsIdx.get(obsStr);
    if (oid === undefined) continue;
    if (model.obsKind[oid] !== 1) continue; // shouldn't happen if pattern is bigram
    const base = model.obsBase[oid] + L; // unigram block is L wide, then L² bigram
    for (let i = 0; i < L2; i++) out[i] += w[base + i];
  }
  return out;
}

// Viterbi over a token sequence. Returns array of label STRINGS (length N).
// `tokens` is an array of arrays — tokens[i][col] is the feature value at
// column `col` for token i (col 0 is the raw token text).
function viterbi(model, tokens) {
  const N = tokens.length;
  const L = model.L;
  if (N === 0) return [];

  const dp = new Float64Array(N * L);
  const bp = new Int32Array(N * L);

  const emit = new Float64Array(L);
  const trans = new Float64Array(L * L);

  unigramScores(model, tokens, 0, emit);
  for (let y = 0; y < L; y++) dp[y] = emit[y];

  for (let t = 1; t < N; t++) {
    unigramScores(model, tokens, t, emit);
    bigramScores(model, tokens, t, trans);
    const prevRow = (t - 1) * L;
    const curRow = t * L;
    for (let y = 0; y < L; y++) {
      let bestPrev = 0;
      let bestScore = -Infinity;
      for (let py = 0; py < L; py++) {
        const s = dp[prevRow + py] + trans[py * L + y];
        if (s > bestScore) {
          bestScore = s;
          bestPrev = py;
        }
      }
      dp[curRow + y] = bestScore + emit[y];
      bp[curRow + y] = bestPrev;
    }
  }

  let best = 0;
  let bestScore = -Infinity;
  for (let y = 0; y < L; y++) {
    const s = dp[(N - 1) * L + y];
    if (s > bestScore) { bestScore = s; best = y; }
  }
  const labelsOut = new Array(N);
  labelsOut[N - 1] = model.labels[best];
  let cur = best;
  for (let t = N - 1; t > 0; t--) {
    cur = bp[t * L + cur];
    labelsOut[t - 1] = model.labels[cur];
  }
  return labelsOut;
}


// ───── features.js ─────
// Feature extraction — ports lib/anystyle/feature/*.rb.
//
// Each feature is a function (token, ctx) → string | string[]. The full
// extractor flattens them into a 20-column row matching the model's templates:
//
//   col 0:  raw token text                       (added by us, not a feature)
//   col 1:  canonical (lowercased)               — Canonical
//   col 2:  first-char Unicode category          — Category[0]
//   col 3:  last-char Unicode category           — Category[-1]
//   col 4:  1-char prefix                        — Affix(prefix, size 2)[0]
//   col 5:  2-char prefix                        — Affix(prefix, size 2)[1]
//   col 6:  1-char suffix                        — Affix(suffix, size 2)[0]
//   col 7:  2-char suffix                        — Affix(suffix, size 2)[1]
//   col 8:  caps category                        — Caps
//   col 9:  number category                      — Number
//   col 10: dict[name]   ('T'|'F')               — Dictionary
//   col 11: dict[place]  ('T'|'F')               — Dictionary
//   col 12: dict[publisher] ('T'|'F')            — Dictionary
//   col 13: dict[journal] ('T'|'F')              — Dictionary
//   col 14: keyword class                        — Keyword
//   col 15: position bucket                      — Position
//   col 16: punctuation class                    — Punctuation
//   col 17: bracket class                        — Brackets
//   col 18: terminal class                       — Terminal
//   col 19: is-locator ('T'|'F')                 — Locator
//
// ctx = { alpha, idx, seqLen, dict }


// --- Canonical ---
function fCanonical(token, ctx) {
  return ctx.alpha === '' ? 'BLANK' : canonize(ctx.alpha);
}

// --- Category --- map char to Unicode general category abbreviation.
function categorize(ch) {
  if (!ch) return 'none';
  if (/\p{Lu}/u.test(ch)) return 'Lu';
  if (/\p{Ll}/u.test(ch)) return 'Ll';
  if (/\p{Lm}/u.test(ch)) return 'Lm';
  if (/\p{L}/u.test(ch)) return 'L';
  if (/\p{M}/u.test(ch)) return 'M';
  if (/\p{N}/u.test(ch)) return 'N';
  if (/\p{Pc}/u.test(ch)) return 'Pc';
  if (/\p{Pd}/u.test(ch)) return 'Pd';
  if (/\p{Ps}/u.test(ch)) return 'Ps';
  if (/\p{Pe}/u.test(ch)) return 'Pe';
  if (/\p{Pi}/u.test(ch)) return 'Pi';
  if (/\p{Pf}/u.test(ch)) return 'Pf';
  if (/\p{P}/u.test(ch)) return 'P';
  if (/\p{S}/u.test(ch)) return 'S';
  if (/\p{Zl}/u.test(ch)) return 'Zl';
  if (/\p{Zp}/u.test(ch)) return 'Zp';
  if (/\p{Z}/u.test(ch)) return 'Z';
  if (/\p{C}/u.test(ch)) return 'C';
  return 'none';
}
function fCategory(token) {
  const chars = Array.from(token); // handles surrogate pairs
  if (chars.length === 0) return ['none', 'none'];
  return [categorize(chars[0]), categorize(chars[chars.length - 1])];
}

// --- Affix(size=2) --- returns [1-char-affix, 2-char-affix]
function fAffix(token, suffix) {
  const chars = Array.from(token);
  if (suffix) {
    // last char, last 2 chars
    return [
      chars.length >= 1 ? chars[chars.length - 1] : '',
      chars.length >= 2 ? chars.slice(-2).join('') : chars.join(''),
    ];
  } else {
    return [
      chars.length >= 1 ? chars[0] : '',
      chars.length >= 2 ? chars.slice(0, 2).join('') : chars.join(''),
    ];
  }
}

// --- Caps ---
function fCaps(token, ctx) {
  const alpha = ctx.alpha;
  if (/^\p{Lu}$/u.test(alpha)) return 'single';
  if (/^\p{Lu}\p{Ll}/u.test(alpha)) return 'initial';
  if (/^\p{Lu}+$/u.test(alpha)) return 'caps';
  if (/^\p{Ll}+$/u.test(alpha)) return 'lower';
  return 'other';
}

// --- Number ---
function fNumber(token) {
  if (/\d[\(:;]\d/.test(token)) return 'volume';
  if (/^97[89](\p{Pd}?\d){10}$/u.test(token) || /^\d(\p{Pd}?\d){9}$/u.test(token)) return 'isbn';
  if (/\b(1\d|20)\d\d\b/.test(token)) return 'year';
  if (/^\d\d\d\d$/.test(token)) return 'quad';
  if (/^\d\d\d$/.test(token)) return 'triple';
  if (/^\d\d$/.test(token)) return 'double';
  if (/^\d$/.test(token)) return 'single';
  if (/^\d+$/.test(token)) return 'all';
  if (/^\d+\p{Pd}+\d+$/u.test(token)) return 'range';
  if (/^\p{Lu}[\p{Lu}\p{Pd}/]+\d+[,.:]?$/u.test(token)) return 'idnum';
  if (/\d\p{L}{1,3}\b/u.test(token)) return 'ordinal';
  if (/\d/.test(token)) return 'numeric';
  if (/^([IVXLDCM]+|[ivx]+)\b/.test(token)) return 'roman';
  return 'none';
}

// --- Dictionary --- returns ['T'|'F', ...] for [name, place, publisher, journal]
const DICT_TAGS = ['name', 'place', 'publisher', 'journal'];
function fDictionary(token, ctx) {
  const dict = ctx.dict;
  if (!dict) return ['F', 'F', 'F', 'F']; // stub when no dict loaded
  return dict.tags(ctx.alpha.toLowerCase());
}

// --- Keyword ---
function fKeyword(token, ctx) {
  const alpha = ctx.alpha || token;
  if (token === '&') return 'and';
  if (/^ed(s|itors?|ited?|iteurs?)?$/i.test(alpha)
      || /^(hg|hrsg|herausgeber)$/i.test(alpha)
      || /^(compilador)$/i.test(alpha)
      || /編/.test(alpha)) return 'editor';
  if (/著|撰/.test(alpha)) return 'author';
  if (/^trans(l(ated|ators?|ation))?$/i.test(alpha)
      || /^übers(etz(t|ung))?$/i.test(alpha)
      || /^trad(uction|ucteurs?|uit)?$/i.test(alpha)
      || /譯/.test(alpha)) return 'translator';
  if (/^(dissertation|thesis)$/i.test(alpha)) return 'thesis';
  if (/^(proceedings|conference|meeting|transactions|communications|seminar|symposi(on|um))/i.test(alpha)) return 'proceedings';
  if (/^(Journal|Zeitschrift|Quarterly|Magazine?|Times|Rev(iew|vue)?|Bulletin|News|Week|Gazett[ea])/.test(alpha)) return 'journal';
  if (/^in$/i.test(alpha) || /收入/.test(alpha)) return 'in';
  if (/^([AaUu]nd|y|e)$/.test(alpha)) return 'and';
  if (/^(etal|others)$/.test(alpha)) return 'etal';
  if (/^(pp?|pages?|S(eiten?)?|ff?)$/.test(alpha)) return 'page';
  if (/^(vol(ume)?s?|iss(ue)?|n[or]?|number|fasc(icle|icule)?|suppl(ement)?|j(ahrgan)?g|heft)$/i.test(alpha)) return 'volume';
  if (/^(ser(ies?)?|reihe|[ck]oll(e[ck]tion))$/i.test(alpha)) return 'series';
  if (/^patent$/i.test(alpha)) return 'patent';
  if (/^report$/i.test(alpha)) return 'report';
  // Note: in the original Ruby this is split across multiple `when`/`,` lines —
  // the `aufl(age)` regex is on a dangling line above the next case body; that's
  // a bug in the Ruby (it falls through). Preserve the same effective behavior.
  if (/^(edn|edition|expanded|rev(ised)?|p?reprint(ed)?|illustrated)$/i.test(alpha)
      || /^editio|aucta$/i.test(alpha)) return 'edition';
  if (/^(nd|date|spring|s[uo]mmer|autumn|fall|winter|frühling|herbst)$/i.test(alpha)
      || /^(jan(uary?)?|feb(ruary?)?|mar(ch|z)?|apr(il)?|ma[yi]|jun[ei]?)$/.test(alpha)
      || /^(jul[yi]?|aug(ust)?|sep(tember)?|o[ck]t(ober)?|nov(ember)?|de[cz](ember)?)$/i.test(alpha)
      || /年/.test(alpha)) return 'date';
  if (/^(doi|url)/i.test(alpha)) return 'locator';
  if (/^(pmid|pmcid)/i.test(alpha)) return 'pubmed';
  if (/^(arxiv)/i.test(alpha)) return 'arxiv';
  if (/^(retrieved|retirado|accessed|ab(ruf|gerufen))$/i.test(alpha)) return 'accessed';
  if (/^[ILXVMCD]{2,}$/.test(alpha)) return 'roman';
  return 'none';
}

// --- Position --- ratio(i, n) when not first/last.
function fPosition(token, ctx) {
  const i = ctx.idx;
  const n = ctx.seqLen;
  if (n === 1) return 'only';
  if (i === 0) return 'first';
  if (i === n - 1) return 'last';
  // ratio: (i/n * 10).round
  const PRECISION = 10;
  return String(Math.round((i / n) * PRECISION));
}

// --- Punctuation ---
function fPunctuation(token) {
  if (/^[^\p{P}]+$/u.test(token)) return 'none';
  if (/:/.test(token)) return 'colon';
  if (/\p{Pd}/u.test(token)) return 'hyphen';
  if (/\./.test(token)) return 'period';
  if (/&/.test(token)) return 'amp';
  return 'other';
}

// --- Brackets ---
function fBrackets(token) {
  if (/^[^()[\]<>]+$/.test(token)) return 'none';
  if (/^\(.*\)[,;:\p{Pd}.]?$/u.test(token)) return 'parens';
  if (/^\[.*\][,;:\p{Pd}.]?$/u.test(token)) return 'square-brackets';
  if (/^<.*>[,;:\p{Pd}.]?$/u.test(token)) return 'angle';
  if (/\)[,;:\p{Pd}.]?$/u.test(token)) return 'closing-paren';
  if (/^\(/.test(token)) return 'opening-paren';
  if (/\][,;:\p{Pd}.]?$/u.test(token)) return 'closing-square-bracket';
  if (/^\[/.test(token)) return 'opening-square-bracket';
  if (/>[,;:\p{Pd}.]?$/u.test(token)) return 'closing-angle';
  if (/^</.test(token)) return 'opening-angle';
  return 'other';
}

// --- Terminal ---
function fTerminal(token) {
  if (/[\.)\]]["'”„’‚´«‘“`»」』)\]]?$/.test(token)
      || /,["'”„’‚´«‘“`»」』)\]]|["'”„’‚´«‘“`»」』)\]],$/.test(token)) return 'strong';
  if (/[:"'”„’‚´«‘“`»」』][,;:\p{Pd}!?.]?$/u.test(token)) return 'moderate';
  if (/[!?,;\p{Pd}]["'”„’‚´«‘“`»」』]?$/u.test(token)) return 'weak';
  return 'none';
}

// --- Locator --- T if the token looks like a DOI/URL/identifier.
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9-]+\.[a-z0-9.-]+(?:\/[^\s]*)?/i;
function fLocator(token) {
  if (/\b(?:DOI|doi|ISBN|Url|URL|PMCID|PMID|PMC\d+|PubMed)\b/.test(token)) return 'T';
  if (/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.test(token)) return 'T';
  if (URL_RE.test(token)) return 'T';
  return 'F';
}

// Build the 20-column feature row for a single token.
//
// Returns: [rawToken, canonical, cat0, cat-1, pre1, pre2, suf1, suf2, caps,
//           number, dict-name, dict-place, dict-pub, dict-jrn, keyword,
//           position, punctuation, brackets, terminal, locator]
function buildRow(token, ctx) {
  const cat = fCategory(token);
  const pre = fAffix(token, false);
  const suf = fAffix(token, true);
  const dict = fDictionary(token, ctx);
  return [
    token,                  // 0
    fCanonical(token, ctx), // 1
    cat[0],                 // 2
    cat[1],                 // 3
    pre[0],                 // 4
    pre[1],                 // 5
    suf[0],                 // 6
    suf[1],                 // 7
    fCaps(token, ctx),      // 8
    fNumber(token),         // 9
    dict[0],                // 10
    dict[1],                // 11
    dict[2],                // 12
    dict[3],                // 13
    fKeyword(token, ctx),   // 14
    fPosition(token, ctx),  // 15
    fPunctuation(token),    // 16
    fBrackets(token),       // 17
    fTerminal(token),       // 18
    fLocator(token),        // 19
  ];
}

// Build feature rows for an array of tokens.
function buildSequence(tokens, opts = {}) {
  const dict = opts.dict || null;
  const seqLen = tokens.length;
  const rows = new Array(seqLen);
  for (let i = 0; i < seqLen; i++) {
    const alpha = scrub(tokens[i]);
    rows[i] = buildRow(tokens[i], { alpha, idx: i, seqLen, dict });
  }
  return rows;
}


// ───── namae.js ─────
// Pragmatic name parser. Ports the *behavior* of the namae gem for the cases
// AnyStyle's parser cares about. Not a full re-implementation — namae is a
// 700-line Bison-generated grammar; we cover the common shapes:
//
//   "Smith, J."             → { family: "Smith", given: "J." }
//   "Smith, John"           → { family: "Smith", given: "John" }
//   "John Smith"            → { family: "Smith", given: "John" }
//   "J. Smith"              → { family: "Smith", given: "J." }
//   "Smith J"               → { family: "Smith", given: "J" }   (Vancouver)
//   "Smith JM"              → { family: "Smith", given: "J. M." }
//
// Lists:
//   "Smith, J. and Jones, K."          (and)
//   "Smith, J.; Jones, K."             (;)
//   "Smith J, Jones K"                 (Vancouver style; comma is the separator)
//   "Smith, J., Jones, K., Brown, A."  (canonical first form, comma+space is separator BUT comma also separates family/given — we resolve by even/odd grouping)
//
// AnyStyle's Names normalizer passes the string through a pre-clean
// (stripping "ed.", "trans.", parens, etc.) before calling us. We do the same
// inside `parse` so callers can use namae directly if they want.

// Suffixes / particles. A particle is a lowercased token that's part of the
// surname (von, van der, de la). A suffix is jr/sr/iii etc.
const PARTICLES = new Set([
  'von', 'van', 'der', 'den', 'de', 'la', 'le', 'du', 'da', 'di', 'del', 'della',
  'dei', 'do', 'dos', 'das', 'el', 'al', 'bin', 'ibn', 'mac', 'mc', 'st', 'st.', 'ten', 'ter',
]);
const SUFFIXES = new Set([
  'jr', 'jr.', 'sr', 'sr.', 'i', 'ii', 'iii', 'iv', 'v', 'esq', 'esq.',
]);

// Split an author-list string into individual name strings.
function splitNames(s) {
  // Strip leading/trailing common rubbish that AnyStyle's `strip` removes.
  s = preClean(s);
  if (!s) return [];

  // "and"/"&"/"und"/"y"/"e" separator. Apply first because comma is ambiguous.
  let parts = s.split(/\s+(?:and|AND|&|und|UND)\s+/);

  // Within each part, semicolons unambiguously split names.
  parts = parts.flatMap(p => p.split(/\s*;\s*/));

  // Comma logic: "Smith, J., Jones, K." — every other comma is the list
  // separator. Heuristic: if pair-grouping (last,first | last,first) makes
  // every group look like a valid "Family, Given" pair, use that. Otherwise
  // each comma is a separator (Vancouver-style "Smith J, Jones K").
  parts = parts.flatMap(p => splitByCommas(p));

  return parts.map(x => x.trim()).filter(x => x.length > 0);
}

function splitByCommas(s) {
  let segs = s.split(/\s*,\s*/).map(x => x.trim()).filter(x => x.length > 0);
  if (segs.length <= 1) return segs.length ? segs : [s];

  // (1) Vancouver style: every segment is "Family Initials" (e.g. "Smith JM").
  // Each segment is its own name.
  if (segs.every(isVancouverName)) return segs;

  // (2) Pair-grouping: "Family, Given, Family, Given, ...". Requires even
  // count AND alternating family-looking / given-looking segments.
  if (segs.length % 2 === 0 && segs.every((seg, i) =>
    i % 2 === 0 ? looksFamily(seg) : looksGiven(seg)
  )) {
    const out = [];
    for (let i = 0; i < segs.length; i += 2) {
      out.push(segs[i] + ', ' + segs[i + 1]);
    }
    return out;
  }

  // (3) Fallback: each segment is one name.
  return segs;
}

const VANCOUVER_RE = /^\p{Lu}\p{L}+(?:[\p{Pd}\s]\p{Lu}\p{L}+)*\s+[\p{Lu}\p{Pd}]{1,4}\.?$/u;
function isVancouverName(s) {
  return VANCOUVER_RE.test(s);
}

function looksFamily(s) {
  // A family name segment: starts with a capital, not a lone initial,
  // not a Vancouver "Family Initials" block (that case is handled separately).
  return /^\p{Lu}\p{L}+/u.test(s)
    && !/^\p{Lu}\.?\s*$/u.test(s)
    && !/^[A-Z]{1,4}\.?$/u.test(s)
    && !VANCOUVER_RE.test(s);
}

function looksGiven(s) {
  // Initials, "John", "John P.", or "JM" (Vancouver-style block of initials).
  // Single non-ASCII capital letter (e.g. "Ł") also counts as an initial.
  return /^\p{Lu}/u.test(s) && (
    /\./.test(s) ||
    /^[A-Z]{1,4}$/.test(s) ||
    /^\p{Lu}\p{L}+/u.test(s) ||
    /^\p{Lu}$/u.test(s)
  );
}

function preClean(s) {
  return s
    .replace(/^[Ii]n:?\s+/, '')
    .replace(/\b[EÉeé]d(s?\.|itors?\.?|ited|iteurs?|ité)(\s+(by|par)\s+|\b|$)/g, '')
    .replace(/\b([Hh](rsg|gg?)\.|Herausgeber)\s+/g, '')
    .replace(/\b[Hh]erausgegeben von\s+/g, '')
    .replace(/\b((d|ein)er )?[Üü]ber(s\.|setzt|setzung|tragen|tragung) v(\.|on)\s+/g, '')
    .replace(/\b[Tt]rans(l?\.|lated|lation)(\s+by\b)?\s*/g, '')
    .replace(/\b[Tt]rad(ucteurs?|(uit|\.)(\s+par\b)?)\s*/g, '')
    .replace(/\b([Dd]ir(\.|ected))(\s+by)?\s+/g, '')
    .replace(/\b([Pp]rod(\.|uce[rd]))(\s+by)?\s+/g, '')
    .replace(/\b([Pp]erf(\.|orme[rd]))(\s+by)?\s+/g, '')
    .replace(/\*/g, '')
    .replace(/\([^)]*\)?/g, '')
    .replace(/\[[^\]]*\)?/g, '')
    .replace(/^\P{L}+|\s+\P{L}+$/gu, '')
    .replace(/[\s,.]+$/, '')
    .replace(/,{2,}/g, ',')
    .replace(/\s+\./g, '.');
}

// Parse a single name into {family, given, particle?, suffix?, dropping-particle?}.
function parseOne(raw) {
  let s = raw.trim();
  if (!s) return null;

  // Vancouver-style FIRST: "Smith JM" or "Smith J" — capital letters at the end
  // with no period. Convert "JM" → "J. M.". Run before suffix detection so
  // "Karageorgiou V" is recognized as Vancouver (given "V.") not Roman suffix.
  const vanM = /^(\p{Lu}\p{L}+(?:[\p{Pd}\s]\p{Lu}\p{L}+)*)\s+([\p{Lu}\p{Pd}]{1,4})$/u.exec(s);
  if (vanM) {
    const family = vanM[1];
    const initialsBlock = vanM[2].replace(/-/g, '');
    const given = Array.from(initialsBlock).map(c => c + '.').join(' ');
    return makeName({ family, given });
  }

  // Suffix detection. Require a comma separator (so "Smith Jr." matches but
  // "Lakatos I" does not — lone "I" is almost always a given-name initial).
  // Drop lone "I" from the list for the same reason.
  let suffix = null;
  const sufM = /,\s*(Jr\.?|Sr\.?|II|III|IV|V|VI|VII|VIII)\.?$/.exec(s);
  if (sufM) {
    suffix = sufM[1];
    s = s.slice(0, sufM.index).trim();
  }

  // Comma form: "Family, Given"
  if (s.includes(',')) {
    const [familyPart, ...rest] = s.split(',').map(x => x.trim());
    const given = rest.join(', ').trim();
    return makeName(extractParticle(familyPart, given), { suffix });
  }

  // Space form: "Given Family" or "Given Particle Family"
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) {
    return makeName({ family: tokens[0], suffix });
  }
  // Identify the last contiguous run of capitalized words as the family.
  // Particles (lowercased) immediately preceding it are part of the family.
  let familyStart = tokens.length - 1;
  while (familyStart > 0 && PARTICLES.has(tokens[familyStart - 1].toLowerCase())) {
    familyStart--;
  }
  const family = tokens.slice(familyStart).join(' ');
  const given = tokens.slice(0, familyStart).join(' ');
  return makeName({ family, given, suffix });
}

function extractParticle(familyPart, given) {
  // "van der Berg" — particles at the start are part of the family
  const parts = familyPart.split(/\s+/);
  if (parts.length > 1 && PARTICLES.has(parts[0].toLowerCase())) {
    let i = 0;
    while (i < parts.length - 1 && PARTICLES.has(parts[i].toLowerCase())) i++;
    return {
      'non-dropping-particle': parts.slice(0, i).join(' '),
      family: parts.slice(i).join(' '),
      given,
    };
  }
  return { family: familyPart, given };
}

function normalizeInitials(s) {
  if (!s) return s;
  // "JM" → "J. M.", "J.M." → "J. M.", "J.-K." stays as-is. Works with
  // non-ASCII capitals (e.g. "Ł" → "Ł.").
  let out = s;
  out = out.replace(/(\p{Lu})(?=\p{Lu})/gu, '$1.');
  out = out.replace(/\.(\p{Lu})/gu, '. $1');
  out = out.replace(/(^|\s)(\p{Lu})(?=\s|$)/gu, '$1$2.');
  return out.trim();
}

function makeName(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const k of Object.keys(layer)) {
      if (layer[k] != null && layer[k] !== '') out[k] = layer[k];
    }
  }
  if (out.given) out.given = normalizeInitials(out.given);
  // strip trailing punct from family
  if (out.family) out.family = out.family.replace(/[,\s]+$/, '');
  return out;
}

function namaeParse(s) {
  const names = splitNames(s);
  return names.map(parseOne).filter(Boolean);
}
const namaeParseOne = parseOne;


// ───── normalizers.js ─────
// Normalizers — port lib/anystyle/normalizer/*.rb.
//
// Each normalizer takes (item, ctx) and mutates `item` (a {key: string[]}
// record). Order matches lib/anystyle/parser.rb. Skipped: Locale (needs CLD3
// language detection).
//
// `item` invariants:
//   - Keys are strings (CSL-ish: 'author', 'date', 'title', 'container-title',
//     'volume', 'issue', 'pages', 'publisher', 'location', 'doi', 'url', ...).
//   - Values are arrays; before Names runs, each entry is a raw labeled span
//     (string). After Names, author/editor/translator/director/producer
//     entries become arrays of name records (`{family, given, ...}`).


// --- helpers ---
function mapValues(item, keys, fn) {
  if (keys == null) keys = Object.keys(item);
  for (const k of keys) {
    if (!Array.isArray(item[k])) continue;
    item[k] = item[k]
      .map(v => fn(k, v))
      .flat()
      .filter(v => v != null && v !== '');
  }
}
function eachValue(item, keys, fn) {
  if (keys == null) keys = Object.keys(item);
  for (const k of keys) {
    if (!Array.isArray(item[k])) continue;
    for (let i = 0; i < item[k].length; i++) {
      const r = fn(k, item[k][i]);
      if (r !== undefined) item[k][i] = r;
    }
  }
}
function append(item, key, value) {
  if (item[key]) item[key].push(value);
  else item[key] = [value];
}

// --- Unicode ---
const UNICODE_KEYS = [
  'collection-title','container-title','author','date','director','doi','edition',
  'editor','genre','isbn','journal','location','medium','note','pages','producer',
  'publisher','title','translator','url','volume',
];
function normUnicode(item) {
  mapValues(item, UNICODE_KEYS, (_, v) => typeof v === 'string' ? v.normalize('NFKC') : v);
}

// --- Quotes ---
const QUOTES_RE = /^[«‹»›„‚“‟‘‛”’"❛❜❟❝❞⹂〝〞〟[]|[«‹»›„‚“‟‘‛”’"❛❜❟❝❞⹂〝〞〟\]]$/g;
function normQuotes(item) {
  eachValue(item, ['title','citation-number','medium'], (_, v) =>
    typeof v === 'string' ? v.replace(QUOTES_RE, '') : v);
}

// --- Brackets ---
function normBrackets(item) {
  eachValue(item, ['citation-number','note'], (_, v) =>
    typeof v === 'string' ? v.replace(/^[([{]|[\]\)\}]$/g, '') : v);
}

// --- Punctuation ---
const PUNCT_KEYS = [
  'container-title','collection-title','date','edition','journal','location',
  'publisher','title',
];
function normPunctuation(item) {
  eachValue(item, PUNCT_KEYS, (_, v) => {
    if (typeof v !== 'string') return v;
    return v
      .replace(/\s*[)\]\.,:;\p{Pd}\p{Z}\p{C}。、》〉]+$/gu, '')
      .replace(/[,:;》〉]+$/g, '')
      .replace(/^[(\[《〈]/g, '')
      .replace(/<\/?(italic|bold)>/g, '');
  });
}

// --- Journal --- moves 'journal' values into 'container-title' and sets type.
function normJournal(item) {
  if (item.journal && item.journal.length) {
    item.type = ['article-journal'];
    for (const j of item.journal) append(item, 'container-title', j);
    delete item.journal;
  }
}

// --- Container ---
function normContainer(item) {
  mapValues(item, ['container-title'], (_, v) =>
    typeof v === 'string'
      ? v
          .replace(/^[Ii]n(?::|\s+the)?\s+(\P{Ll})/u, '$1')
          .replace(/^of\s+/, '')
          .replace(/^收入/, '')
          .replace(/^(\w+ )?presented at (the )?/i, '')
      : v
  );
}

// --- Edition ---
function normEdition(item) {
  mapValues(item, ['edition'], (_, v) =>
    typeof v === 'string'
      ? v.replace(/rev\./g, 'revised').replace(/([eé]d(\.|ition)?|ausg(\.|abe)?)$/i, '').trim()
      : v
  );
}

// --- Volume --- splits volume into volume/issue/pages/date as appropriate.
const VOLNUM = '(\\p{Lu}?\\d+|[IVXLCDM]+)';
function normVolume(item) {
  if (!item.volume) return;
  for (let i = 0; i < item.volume.length; i++) {
    let vol = stripHtml(item.volume[i]);

    if (!item.date || item.date.length === 0) {
      const dm = /([12]\d{3});|\(([12]\d{3})\)|\/([12]\d{3})/.exec(vol);
      if (dm) {
        vol = vol.replace(dm[0], '');
        append(item, 'date', dm[1] || dm[2] || dm[3]);
      }
    }

    let m;
    if ((m = new RegExp(`(?:^|\\s)${VOLNUM}\\s?\\(([^)]+)\\)[;:,]?(?:pp?\\.?)?(\\s?\\d+\\p{Pd}\\d+)?`, 'u').exec(vol))) {
      vol = m[1];
      append(item, 'issue', m[2]);
      if (m[3]) append(item, 'pages', m[3].trim());
    } else if ((m = new RegExp(`(?:${VOLNUM}(?:\\.?\\s*J(?:ahrgan)?g\\.?)?[\\p{P}\\s]+)?(?:nos?|nr|n°|nº|iss?|fasc|heft|h)\\.?\\s?(.+)$`, 'iu').exec(vol))) {
      vol = m[1] || '';
      append(item, 'issue', m[2].replace(/\p{P}$/u, ''));
    } else if ((m = new RegExp(`${VOLNUM}:(\\d+(\\p{Pd}\\d+)?)`, 'u').exec(vol))) {
      const v0 = m[1];
      const tail = m[2];
      const isPages = !m[3] || (item.pages && item.pages.length);
      append(item, isPages ? 'issue' : 'pages', tail);
      vol = v0;
    } else if ((m = new RegExp(`${VOLNUM}[./](\\S+)`, 'u').exec(vol))) {
      vol = m[1];
      append(item, 'issue', m[2].replace(/\p{P}$/u, ''));
    } else if ((m = /(\d+) [Vv]ol/.exec(vol)) || (m = /J(?:ahrgan)?g\.?\s+(\d+)/.exec(vol))) {
      vol = m[1];
    } else {
      vol = vol
        .replace(/<\/?(italic|i|strong|b|span|div)>/g, '')
        .replace(/^[\p{P}\s]+/u, '')
        .replace(/^[Vv]ol(ume)?[\p{P}\s]+/u, '')
        .replace(/[\p{P}\p{Z}\p{C}]+$/gu, '');
    }
    item.volume[i] = vol;
  }
  item.volume = item.volume.filter(v => v && v.length);
  if (item.volume.length === 0) delete item.volume;
}

function stripHtml(s) {
  return s.replace(/<\/?(italic|i|strong|b|span|div)(\s+style="[^"]+")?>/gi, '');
}

// --- Page ---
function normPage(item) {
  mapValues(item, ['pages'], (_, value) => {
    let pages = value;
    const m = /(\d+)(?:\.(\d+))?(?:\((\d{4})\))?:(\d.*)/.exec(value);
    if (m) {
      append(item, 'volume', String(parseInt(m[1], 10)));
      if (m[2]) append(item, 'issue', String(parseInt(m[2], 10)));
      if (m[3]) append(item, 'year', String(parseInt(m[3], 10)));
      pages = m[4];
    }
    return pages.replace(/\p{Pd}+/gu, '–').replace(/[^\d,–]+/g, ' ').trim();
  });
}

// --- Date ---
function normDate(item) {
  mapValues(item, ['date'], (_, value) => {
    if (unknownDate(value)) return 'XXXX';
    if (intervalDate(value)) return value;
    if (isoDate(value)) return value;
    const year = extractYear(value);
    if (year == null) return value;
    const month = extractMonth(value);
    const day = month ? extractDay(value) : null;
    const parts = [year, month, day].filter(x => x != null).join('-');
    return parts + (extractUncertainty(value) || '');
  });
}
function isoDate(d) { return /[012]\d\d\d-\d\d-\d\d/.test(d); }
function intervalDate(d) { return /\/|\s\p{Pd}\s|(\s([12]?\d|30)\p{Pd}([12]?\d|3[01])?)/u.test(d); }
function unknownDate(d) { return /inconnue|unknown|unbekannt|[ns]\. ?d\b|no date/i.test(d); }
function uncertainDate(d) { return /\?/.test(d); }
function approximateDate(d) { return /(\b(circa|ca\.|vers|approx))|(^[cv]\.)/i.test(d); }
function extractUncertainty(d) {
  if (approximateDate(d)) return uncertainDate(d) ? '%' : '~';
  if (uncertainDate(d)) return '?';
  return null;
}
function extractYear(d) {
  const m = /\D?([012]\d\d\d)\D?/.exec(d);
  return m ? m[1] : null;
}
function extractDay(d) {
  const m = /\b([012]?\d|3[01])\b/.exec(d);
  return m ? String(parseInt(m[1], 10)).padStart(2, '0') : null;
}
function extractMonth(d) {
  if (/\bjan/i.test(d)) return '01';
  if (/\bf(eb|év)/i.test(d)) return '02';
  if (/\bmar/i.test(d)) return '03';
  if (/\ba[pv]r/i.test(d)) return '04';
  if (/\bma[yi]/i.test(d)) return '05';
  if (/\bjui?n/i.test(d)) return '06';
  if (/\bjui?l/i.test(d)) return '07';
  if (/\ba(ug|oût)/i.test(d)) return '08';
  if (/\bsep/i.test(d)) return '09';
  if (/\bo[ck]t/i.test(d)) return '10';
  if (/\bnov/i.test(d)) return '11';
  if (/\bd[eé]c/i.test(d)) return '12';
  return null;
}

// --- Location ---
function normLocation(item) {
  mapValues(item, ['location'], (_, value) => {
    let loc = String(value).replace(/^\P{L}+|\P{L}+$/gu, '');
    if (!item.publisher && loc.includes(':')) {
      const [a, b] = loc.split(/\s*:\s*/);
      loc = a;
      if (b) append(item, 'publisher', b);
    }
    return loc;
  });
}

// --- Locator (ISBN/URL/DOI cleanup) ---
function doiExtract(v) {
  const m = /10(\.(\d{4,9}\/[-._;()/:A-Z0-9]+|1002\/\S+)|\/\p{L}{3,})/i.exec(v);
  return m ? m[0] : null;
}
function normLocator(item) {
  mapValues(item, ['isbn'], (_, v) => {
    const m = /[\d-]+/.exec(v);
    return m ? m[0] : v;
  });
  mapValues(item, ['url'], (_, v) => {
    if (/doi\.org\//i.test(v)) {
      const doi = doiExtract(v);
      if (doi) append(item, 'doi', doi);
    }
    const urls = (v.match(/\b(?:https?|ftps?):\/\/\S+/gi) || []);
    return urls.length ? urls : v;
  });
  mapValues(item, ['doi'], (_, v) => doiExtract(v) || v);
}

// --- Publisher ---
function normPublisher(item) {
  if (!item.publisher || !item.author) return;
  for (let i = 0; i < item.publisher.length; i++) {
    if (item.publisher[i] === 'Author') {
      item.publisher[i] = typeof item.author[0] === 'string' ? item.author[0]
        : (item.author[0] && (item.author[0].family || '')) || 'Author';
    }
  }
}

// --- PubMed ---
function normPubmed(item) {
  eachValue(item, ['note'], (_, v) => {
    if (typeof v !== 'string') return;
    const p = /PMID:?\s*(\d+)/.exec(v);
    if (p) append(item, 'pmid', p[1]);
    const c = /PMC(\d+)/.exec(v);
    if (c) append(item, 'pmcid', c[1]);
  });
}

// --- ArXiv ---
function normArxiv(item) {
  eachValue(item, ['note'], (_, v) => {
    if (typeof v !== 'string') return;
    const m = /arxiv:?\s*(\d{4}\.\d+(?:v\d+)?|\w+(?:.\w+)?\/\d+)/i.exec(v);
    if (m) append(item, 'arxiv', m[1]);
  });
}

// --- Names ---
const NAME_KEYS = ['author','editor','translator','director','producer'];
function normNames(item, ctx) {
  for (const k of NAME_KEYS) {
    if (!item[k]) continue;
    item[k] = item[k].flatMap(value => {
      if (typeof value !== 'string') return [value]; // already parsed
      let v = value.replace(/(^[(\[]|[,;:)\]]+$)/g, '');
      if (isRepeater(v) && ctx.prev && ctx.prev.length) {
        const last = ctx.prev[ctx.prev.length - 1];
        const reuse = (last[k] && last[k][0]) || (last.author && last.author[0]) || (last.editor && last.editor[0]);
        return reuse ? [reuse] : [{ literal: v.trim() }];
      }
      try {
        const parsed = namaeParse(v);
        return parsed.length ? parsed : [{ literal: v.trim() }];
      } catch {
        return [{ literal: v.trim() }];
      }
    });
  }
}
function isRepeater(v) {
  return /^([\p{Pd}_*][\p{Pd}_* ]+|\p{Co})(,|:|\.|$)/u.test(v);
}

// --- Type (classify item) ---
function normType(item) {
  if (item.type && item.type.length) return;
  const keys = new Set(Object.keys(item));
  let t = null;
  if (keys.has('container-title')) {
    if (keys.has('issue')) t = 'article-journal';
    else if (/proceedings|proc\.|conference|meeting|symposi(on|um)/i.test((item['container-title'] || []).join(' '))) t = 'paper-conference';
    else if (/journal|zeitschrift|quarterly|review|revue/i.test((item['container-title'] || []).join(' '))) t = 'article-journal';
    else t = 'chapter';
  } else if (keys.has('genre') || keys.has('note')) {
    const s = [].concat(item.genre || [], item.note || []).join(' ');
    if (/ph(\.\s*)?d|diss(\.|ertation)|thesis/i.test(s)) t = 'thesis';
    else if (/rep(\.|ort)/i.test(s)) t = 'report';
    else if (/unpublished|manuscript/i.test(s)) t = 'manuscript';
    else if (/patent/i.test(s)) t = 'patent';
    else if (/personal communication/i.test(s)) t = 'personal_communication';
    else if (/interview/i.test(s)) t = 'interview';
    else if (/web|online|en ligne/i.test(s)) t = 'webpage';
  } else if (keys.has('medium')) {
    const s = (item.medium || []).join(' ');
    if (/dvd|video|vhs|motion/i.test(s)) t = 'motion_picture';
    else if (/television/i.test(s)) t = 'broadcast';
  } else if (keys.has('publisher')) {
    t = 'book';
  }
  if (t) item.type = [t];
}

// --- pipeline ---
function normalize(item, ctx = {}) {
  normUnicode(item);
  normQuotes(item);
  normBrackets(item);
  normPunctuation(item);
  normJournal(item);
  normContainer(item);
  normEdition(item);
  normVolume(item);
  normPage(item);
  normDate(item);
  normLocation(item);
  normLocator(item);
  normPublisher(item);
  normPubmed(item);
  normArxiv(item);
  normNames(item, ctx);
  normType(item);
  return item;
}


// ───── anystyle.js ─────
// AnyStyle JS — public API.
//
// Pipeline:
//   text blob → tokenize → feature rows → Viterbi → labeled token sequence
//   → group by label → normalize → CSL-ish JS objects.


// Group consecutive same-label tokens into "spans"; collect spans per label
// into the item hash. Single-token spans are joined with spaces.
function sequenceToItem(tokens, labels) {
  const item = {};
  let curLabel = null;
  let buf = [];
  const flush = () => {
    if (buf.length && curLabel) {
      const text = buf.join(' ');
      if (item[curLabel]) item[curLabel].push(text);
      else item[curLabel] = [text];
    }
    buf = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    if (labels[i] !== curLabel) { flush(); curLabel = labels[i]; }
    buf.push(tokens[i]);
  }
  flush();
  return item;
}

class Parser {
  constructor({ model, dict } = {}) {
    if (!model) throw new Error('Parser requires a loaded model');
    this.model = model;
    this.dict = dict || null;
  }

  // Parse a blob of references. Returns an array of CSL-ish objects.
  parse(blob) {
    const seqs = tokenize(blob);
    const out = [];
    for (const tokens of seqs) {
      if (tokens.length === 0) continue;
      const rows = buildSequence(tokens, { dict: this.dict });
      const labels = viterbi(this.model, rows);
      const item = sequenceToItem(tokens, labels);
      normalize(item, { prev: out });
      out.push(unwrapSingletons(item));
    }
    return out;
  }

  // Lower-level: parse, but don't normalize. Returns array of
  // { tokens, labels, raw } for inspection.
  label(blob) {
    const seqs = tokenize(blob);
    return seqs.map(tokens => {
      if (tokens.length === 0) return { tokens: [], labels: [] };
      const rows = buildSequence(tokens, { dict: this.dict });
      const labels = viterbi(this.model, rows);
      return { tokens, labels };
    });
  }
}

// CSL-JSON convention is that each field is a single value (string or object),
// not an array. Collapse single-element arrays after normalization.
function unwrapSingletons(item) {
  const out = {};
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (Array.isArray(v) && v.length === 1) out[k] = v[0];
    else out[k] = v;
  }
  return out;
}

// Convenience: load model + dict from text/JSON in one call.
function createParser({ modelText, dictJSON }) {
  const model = loadModel(modelText);
  const dict = dictJSON ? Dictionary.fromJSON(dictJSON) : null;
  return new Parser({ model, dict });
}




  return {
    Parser, createParser, loadModel, Dictionary,
    tokenize, buildSequence, viterbi, normalize,
    namae: { parse: namaeParse, parseOne: namaeParseOne },
  };
}));
