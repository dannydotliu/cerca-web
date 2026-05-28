// Bundle src/ into a single anystyle.bundle.js that works in both Node and
// browser. Concatenates modules, strips require()/module.exports, exposes
// API as a UMD-style global.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'dist', 'anystyle.bundle.js');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Order matters: dependents come after their deps.
const MODULES = ['strings', 'tokenize', 'dict', 'wapiti', 'features', 'namae', 'normalizers', 'anystyle'];

function readModule(name) {
  let src = fs.readFileSync(path.join(SRC, name + '.js'), 'utf8');
  // Strip the 'use strict' directive — we put a single one at top of bundle.
  src = src.replace(/^'use strict';\n/m, '');
  // Strip require() lines — modules will share an internal namespace.
  src = src.replace(/^const\s+\{[^}]+\}\s*=\s*require\(['"][^'"]+['"]\);?\n/gm, '');
  src = src.replace(/^const\s+\w+\s*=\s*require\(['"][^'"]+['"]\);?\n/gm, '');
  // Remove module.exports — we collect exports manually.
  const exportsMatch = /module\.exports\s*=\s*(\{[\s\S]*?\});?\s*$/m.exec(src);
  let exports = null;
  if (exportsMatch) {
    exports = exportsMatch[1];
    src = src.replace(exportsMatch[0], '');
  }
  return { src, exports };
}

const header = `// AnyStyle JS — client-side reference parser. Port of inukshuk/anystyle.
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

`;

const footer = `

  return {
    Parser, createParser, loadModel, Dictionary,
    tokenize, buildSequence, viterbi, normalize,
    namae: { parse: namaeParse, parseOne: namaeParseOne },
  };
}));
`;

// Concatenate.
let bundle = header;
const allExports = {};
for (const name of MODULES) {
  const { src, exports } = readModule(name);
  bundle += `// ───── ${name}.js ─────\n` + src + '\n';
  if (exports) allExports[name] = exports;
}

// Inject namae aliases (so we can expose them in footer without colliding
// with normalizers.js which imports namae as a module).
bundle = bundle.replace(
  /\nfunction parse\(s\) \{\n  const names = splitNames\(s\);\n  return names\.map\(parseOne\)\.filter\(Boolean\);\n\}\n/,
  '\nfunction namaeParse(s) {\n  const names = splitNames(s);\n  return names.map(parseOne).filter(Boolean);\n}\nconst namaeParseOne = parseOne;\n'
);
// And update normalizers' reference to namae.parse → namaeParse.
bundle = bundle.replace(/namae\.parse\(/g, 'namaeParse(');

bundle += footer;

fs.writeFileSync(OUT, bundle);
const size = fs.statSync(OUT).size;
console.log(`wrote ${OUT}: ${(size / 1024).toFixed(1)} KB`);
