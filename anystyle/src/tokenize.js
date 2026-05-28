// Tokenization. Ports AnyStyle's parser defaults:
//   separator: /(?:\r?\n)+/        — between reference sequences
//   delimiter: /(\s|\p{Space_Separator})+|([！-､]|。|、)/u
//                                   — within a reference: split on whitespace,
//                                     OR keep CJK punctuation as standalone tokens.
//
// The delimiter has two alternatives:
//   group 1: pure whitespace → consumed (used as a separator)
//   group 2: CJK punctuation character → kept as its own token
'use strict';

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

module.exports = { tokenize, tokenizeRef };
