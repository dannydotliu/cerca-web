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
'use strict';

const namae = require('./namae');

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
        const parsed = namae.parse(v);
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

module.exports = {
  normalize,
  // exported for tests
  normUnicode, normQuotes, normBrackets, normPunctuation, normJournal,
  normContainer, normEdition, normVolume, normPage, normDate, normLocation,
  normLocator, normPublisher, normPubmed, normArxiv, normNames, normType,
};
