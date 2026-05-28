// One-time preprocessor: read AnyStyle's dict.txt.gz (set of tagged wordlists)
// and emit a compact JSON map word → bitmask over {name, place, publisher, journal}.
//
// Bit layout matches AnyStyle's lib/anystyle/dictionary.rb: tag order is
// [name, place, publisher, journal] → bits 1,2,4,8.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TAG_BITS = { name: 1, place: 2, publisher: 4, journal: 8 };

const src = path.join(__dirname, '..', 'model', 'dict.txt.gz');
const text = zlib.gunzipSync(fs.readFileSync(src)).toString('utf8');

const db = Object.create(null);
let mode = 0;
let count = 0;

for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;
  const tagM = /^#!\s*(\w+)/i.exec(line);
  if (tagM) {
    const t = tagM[1].toLowerCase();
    mode = TAG_BITS[t] || 0;
    continue;
  }
  if (line.startsWith('#')) continue;
  // entry might be "word\t0.123" (frequency). Strip trailing freq.
  const key = line.split(/\s+(\d+\.\d+)\s*$/)[0];
  if (!key) continue;
  db[key] = (db[key] || 0) | mode;
  count++;
}

const keys = Object.keys(db);
console.log(`processed ${count} lines, ${keys.length} unique keys`);

// Emit a compact JSON. To keep file size down for the browser bundle we
// encode as a single object with single-character values (mask 0-15 fits in
// one hex digit). Total size estimate: ~3 MB raw JSON for ~150k keys.
const outObj = {};
for (const k of keys) outObj[k] = db[k];
const outPath = path.join(__dirname, '..', 'model', 'dict.json');
fs.writeFileSync(outPath, JSON.stringify(outObj));
const stat = fs.statSync(outPath);
console.log(`wrote ${outPath}: ${(stat.size / 1024).toFixed(0)} KB`);

// Also emit a gzipped version for shipping over the wire.
const gz = zlib.gzipSync(JSON.stringify(outObj), { level: 9 });
fs.writeFileSync(outPath + '.gz', gz);
console.log(`wrote ${outPath}.gz: ${(gz.length / 1024).toFixed(0)} KB`);
