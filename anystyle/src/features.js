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
'use strict';

const { canonize, scrub } = require('./strings');

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

module.exports = {
  buildRow,
  buildSequence,
  // exported individually for testing
  fCanonical, fCategory, fAffix, fCaps, fNumber, fDictionary,
  fKeyword, fPosition, fPunctuation, fBrackets, fTerminal, fLocator,
};
