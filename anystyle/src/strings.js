// String utilities ported from lib/anystyle/utils.rb (StringUtils).
// JS Unicode property regexes (\p{Lu} etc.) require the `u` flag.
'use strict';

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

module.exports = { scrub, transliterate, canonize, nnum, displayChars };
