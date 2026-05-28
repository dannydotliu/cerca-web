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
'use strict';

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

function parse(s) {
  const names = splitNames(s);
  return names.map(parseOne).filter(Boolean);
}

module.exports = { parse, parseOne, splitNames, preClean, normalizeInitials };
