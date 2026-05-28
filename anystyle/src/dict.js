// Dictionary lookup. Ports lib/anystyle/dictionary.rb.
//
// Wordlist data lives in model/dict.json (built by scripts/build_dict.js
// from anystyle-data's dict.txt.gz). Each word maps to a 4-bit mask:
//   bit 0 (1): name
//   bit 1 (2): place
//   bit 2 (4): publisher
//   bit 3 (8): journal
'use strict';

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

module.exports = { Dictionary, TAG_BITS, TAGS_ORDER };
