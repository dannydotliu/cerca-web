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

'use strict';

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

module.exports = {
  loadModel,
  readQuark,
  parsePatternBody,
  expandObs,
  unigramScores,
  bigramScores,
  viterbi,
};
