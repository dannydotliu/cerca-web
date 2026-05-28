// AnyStyle JS — public API.
//
// Pipeline:
//   text blob → tokenize → feature rows → Viterbi → labeled token sequence
//   → group by label → normalize → CSL-ish JS objects.
'use strict';

const { loadModel, viterbi } = require('./wapiti');
const { tokenize } = require('./tokenize');
const { buildSequence } = require('./features');
const { Dictionary } = require('./dict');
const { normalize } = require('./normalizers');

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

module.exports = { Parser, createParser, loadModel, Dictionary };
