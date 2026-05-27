// cerca-web — single-file reference checker.
// Copyright (C) 2025 Danny Liu and contributors.
// JavaScript port of CERCA (https://github.com/lidianycs/cerca) by Lidiany Cerqueira.
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License v3.0 as published by the
// Free Software Foundation. This program is distributed WITHOUT ANY WARRANTY.
// See <https://www.gnu.org/licenses/agpl-3.0.html> for the full license.
//
// Source code: https://github.com/dannydotliu/cerca-web
// All API calls go directly from the browser. No server.

const PASS_THRESHOLD = 75;
const CHECK_THRESHOLD = 50;
const CONCURRENCY = 3;

// Per-host 1-req/sec gate for the rate-limited fallback APIs.
function makeRateLimiter(minIntervalMs) {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const out = await fn();
      await new Promise(r => setTimeout(r, minIntervalMs));
      return out;
    });
    chain = run.catch(() => {}); // don't break the chain on a single failure
    return run;
  };
}
const s2Gate = makeRateLimiter(1100);
const zenodoGate = makeRateLimiter(1100);

const $ = (id) => document.getElementById(id);
const state = { items: [] };

// ---------- settings (localStorage) ----------
$("email").value = localStorage.getItem("cerca.email") || "";
$("s2key").value = localStorage.getItem("cerca.s2key") || "";
$("email").addEventListener("change", e => localStorage.setItem("cerca.email", e.target.value.trim()));
$("s2key").addEventListener("change", e => localStorage.setItem("cerca.s2key", e.target.value.trim()));

// ---------- reference parsing (heuristic, no CERMINE) ----------
function parseReference(raw) {
  // Strip leading numbering: "[1] ", "1. ", "(1) "
  let s = raw.replace(/^[\[(]?\d+[\])]?[.,:]?\s*/, "").trim();

  // Try to split on the first year in parens or brackets: "(2017)" or "[2017]"
  const yearMatch = s.match(/[\(\[](1[89]\d{2}|20\d{2}|21\d{2})[a-z]?[\)\]]\.?\s*/);
  let authors = "", title = "", afterTitle = "";
  if (yearMatch) {
    authors = s.slice(0, yearMatch.index).replace(/[.,;\s]+$/, "").trim();
    const rest = s.slice(yearMatch.index + yearMatch[0].length).trim();
    // Title = first sentence-like fragment ending in . ? !
    const t = rest.match(/^(.*?[.?!])\s+(.*)$/);
    if (t) { title = t[1].replace(/[.?!]\s*$/, "").trim(); afterTitle = t[2]; }
    else   { title = rest.replace(/[.?!]\s*$/, "").trim(); }
  } else {
    // No year — assume "Authors. Title. Rest."
    const parts = s.split(/\.\s+/);
    if (parts.length >= 2) {
      authors = parts[0].trim();
      title = parts[1].trim();
      afterTitle = parts.slice(2).join(". ");
    } else {
      title = s;
    }
  }

  // DOI sniff
  const doiMatch = s.match(/\b10\.\d{4,9}\/[^\s,]+/i);
  const doi = doiMatch ? doiMatch[0].replace(/[.,;]+$/, "") : "";

  if (!title) title = s;
  return { authors: authors || "", title: title || s, doi, raw: s };
}

// ---------- scoring (mirrors Java fuzzywuzzy combination) ----------
function score(pdfTitle, pdfAuthors, dbTitle, dbAuthors, rawFallback = false) {
  const a = (s) => (s || "").toLowerCase();
  const titleScore = rawFallback
    ? fuzzball.partial_ratio(a(dbTitle), a(pdfTitle))
    : fuzzball.ratio(a(dbTitle), a(pdfTitle));
  const authorScore = fuzzball.token_sort_ratio(dbAuthors || "", pdfAuthors || "");
  let final;
  if (authorScore < 40) final = Math.min(titleScore, 50);
  else final = Math.round(titleScore * 0.6 + authorScore * 0.4);
  return { final, titleScore, authorScore };
}

// ---------- API clients ----------
async function tryFetch(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, json: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function verifyCrossref(item) {
  const email = $("email").value.trim();
  const headers = {}; // Crossref User-Agent is restricted in browsers; use mailto in query instead
  let url;
  if (item.doi) {
    url = `https://api.crossref.org/works/${encodeURIComponent(item.doi)}`;
  } else {
    const q = encodeURIComponent((item.title || item.raw).slice(0, 200));
    url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=1` + (email ? `&mailto=${encodeURIComponent(email)}` : "");
  }
  const res = await tryFetch(url, { headers });
  if (!res.ok) return false;
  const msg = res.json["message-type"] === "work" ? res.json.message : res.json.message?.items?.[0];
  if (!msg) return false;
  const dbTitle = (msg.title && msg.title[0]) || "";
  const dbAuthors = (msg.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ")).join("; ");
  const dbDoi = msg.DOI || "";
  applyMatch(item, "Crossref", dbTitle, dbAuthors, dbDoi);
  return true;
}

async function verifyOpenAlex(item) {
  const email = $("email").value.trim();
  const q = encodeURIComponent(item.title || item.raw);
  const url = `https://api.openalex.org/works?search=${q}&per-page=1` + (email ? `&mailto=${encodeURIComponent(email)}` : "");
  const res = await tryFetch(url);
  if (!res.ok) return false;
  const w = res.json.results?.[0];
  if (!w) return false;
  const dbTitle = w.title || "";
  const dbAuthors = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).join("; ");
  const dbDoi = (w.doi || "").replace(/^https?:\/\/doi\.org\//, "");
  applyMatch(item, "OpenAlex", dbTitle, dbAuthors, dbDoi);
  return true;
}

async function verifyZenodo(item) {
  // Zenodo's CORS posture is inconsistent; best-effort. Throttled to 1/sec.
  const cleanQ = (item.title || item.raw).replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  const url = `https://zenodo.org/api/records?q=metadata.title:(${encodeURIComponent(cleanQ)})&sort=bestmatch&size=1`;
  const res = await zenodoGate(() => tryFetch(url));
  if (!res.ok) return false;
  const hit = res.json.hits?.hits?.[0];
  if (!hit) return false;
  const md = hit.metadata || {};
  const dbTitle = md.title || "";
  const dbAuthors = (md.creators || []).map(c => c.name).filter(Boolean).join("; ");
  const dbDoi = hit.doi || md.doi || "";
  applyMatch(item, "Zenodo", dbTitle, dbAuthors, dbDoi);
  return true;
}

async function verifyS2(item) {
  const apiKey = $("s2key").value.trim();
  if (!apiKey) return false; // S2 without a key is heavily rate-limited; skip
  const cleanQ = (item.title || item.raw).replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(cleanQ)}&limit=1&fields=title,authors,externalIds`;
  const res = await s2Gate(() => tryFetch(url, { headers: { "x-api-key": apiKey } }));
  if (!res.ok) return false;
  const p = res.json.data?.[0];
  if (!p) return false;
  const dbTitle = p.title || "";
  const dbAuthors = (p.authors || []).map(a => a.name).filter(Boolean).join("; ");
  const dbDoi = p.externalIds?.DOI || (p.externalIds?.ArXiv ? "arXiv:" + p.externalIds.ArXiv : "");
  applyMatch(item, "S2", dbTitle, dbAuthors, dbDoi);
  return true;
}

function applyMatch(item, source, dbTitle, dbAuthors, dbDoi) {
  const rawFallback = !item.title || item.title === item.raw;
  const { final } = score(item.title, item.authors, dbTitle, dbAuthors, rawFallback);
  // Only keep this match if it improves the score
  if (final > (item.matchScore || 0)) {
    item.matchScore = final;
    item.dbTitle = dbTitle;
    item.dbAuthors = dbAuthors;
    item.dbDoi = dbDoi || item.dbDoi;
    item.source = source;
  }
}

// ---------- pipeline ----------
async function verifyOne(item) {
  item.status = "searching";
  render();
  await verifyCrossref(item).catch(() => {});
  if ((item.matchScore || 0) < PASS_THRESHOLD) await verifyOpenAlex(item).catch(() => {});
  if ((item.matchScore || 0) < PASS_THRESHOLD && /zenodo/i.test(item.raw)) await verifyZenodo(item).catch(() => {});
  if ((item.matchScore || 0) < PASS_THRESHOLD) await verifyS2(item).catch(() => {});

  const s = item.matchScore || 0;
  item.status = s >= PASS_THRESHOLD ? "pass" : (s >= CHECK_THRESHOLD ? "check" : "fail");
  item.verified = s >= PASS_THRESHOLD;
  render();
}

async function verifyAll() {
  $("verifyBtn").disabled = true;
  $("loadBtn").disabled = true;
  const total = state.items.length;
  let done = 0;
  setStatus(`Verifying 0 of ${total}…`);

  // Worker-pool concurrency: CONCURRENCY workers pull from a shared index.
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      await verifyOne(state.items[i]);
      done++;
      setStatus(`Verified ${done} of ${total}…`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  setStatus("Verification complete.");
  $("verifyBtn").disabled = false;
  $("loadBtn").disabled = false;
  $("csvBtn").disabled = false;
  $("txtBtn").disabled = false;
}

// ---------- UI ----------
function setStatus(msg) { $("status").textContent = msg; }

// Detect whether a line starts a new reference (vs. continues the previous one
// after a PDF-copy linebreak). Layered: hard negatives kill obvious continuations,
// then any one positive signal triggers a new ref.
function startsNewRef(line) {
  const numbered = /^[\[(]?\d+[\])]?[.,:]?\s+/;
  const stripped = line.replace(numbered, "");
  if (!stripped) return false;

  // Hard negatives — these can never start a reference
  if (/^[\p{Ll}]/u.test(stripped)) return false;           // lowercase first letter
  if (/^https?:\/\//i.test(stripped)) return false;         // URL continuation
  if (/^(doi|arxiv|isbn|pp?\.?|vol\.?)[:.\s]/i.test(stripped)) return false;
  if (/^[\d&,]/.test(stripped)) return false;               // digits / "& Smith..."

  // Positive signals
  // (1) Author with initial: "Smith, J." or "de Barba, P."
  if (/^[\p{L}'\-]+(?:\s+[\p{L}'\-]+)?,\s+[A-Z](?:\.|[\p{Ll}])/u.test(stripped)) return true;
  // (2) Leading number marker present: "1. ..." or "[1] ..." — Vancouver/IEEE
  if (numbered.test(line)) return true;
  // (3) Year-in-parens within the first 120 chars: "(2020)" — corporate/APA variants
  if (/^[^()\n]{0,120}\(\d{4}[a-z]?\)/.test(stripped)) return true;
  // (4) IEEE inline-author: "J. Smith and A. Doe, ..."
  if (/^[A-Z]\.(?:\s*[A-Z]\.)*\s+[\p{L}'\-]+,/u.test(stripped)) return true;

  return false;
}

// Join PDF-wrapped lines back into whole references.
function joinPastedLines(text) {
  const lines = text.split(/\r?\n/);
  const refs = [];
  let buf = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (buf) { refs.push(buf); buf = ""; } continue; }
    if (startsNewRef(line)) {
      if (buf) refs.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + " " + line : line;
    }
  }
  if (buf) refs.push(buf);
  // Safety net: heuristic matched nothing → fall back to one-ref-per-line.
  if (refs.length === 0) return lines.map(l => l.trim()).filter(Boolean);
  return refs;
}

function loadFromTextarea() {
  const lines = joinPastedLines($("input").value).filter(l => l.length >= 5);
  state.items = lines.map((raw, i) => {
    const p = parseReference(raw);
    return {
      id: i + 1, raw: p.raw, authors: p.authors, title: p.title, doi: p.doi,
      matchScore: 0, dbTitle: "", dbAuthors: "", dbDoi: "", source: "",
      status: "waiting", verified: false,
    };
  });
  $("verifyBtn").disabled = state.items.length === 0;
  $("csvBtn").disabled = true;
  $("txtBtn").disabled = true;
  setStatus(`Loaded ${state.items.length} references. Ready to verify.`);
  render();
}

function badge(item) {
  if (item.status === "waiting") return `<span class="badge wait">waiting</span>`;
  if (item.status === "searching") return `<span class="badge wait">searching…</span>`;
  if (item.status === "pass") return `<span class="badge pass">PASS</span>`;
  if (item.status === "check") return `<span class="badge check">CHECK</span>`;
  return `<span class="badge fail">FAIL</span>`;
}

function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

function render() {
  const tb = $("tbody");
  tb.innerHTML = state.items.map(it => `
    <tr>
      <td>${it.id}</td>
      <td>${badge(it)}${it.source ? `<div class="small">${esc(it.source)}</div>` : ""}</td>
      <td>${it.matchScore || ""}</td>
      <td class="truncate"><div>${esc(it.title)}</div><div class="small">${esc(it.authors)}</div></td>
      <td class="truncate"><div>${esc(it.dbTitle)}</div><div class="small">${esc(it.dbAuthors)}</div></td>
      <td class="small">${esc(it.doi)}</td>
      <td class="small">${esc(it.dbDoi)}</td>
    </tr>
  `).join("");
  const total = state.items.length;
  const pass = state.items.filter(i => i.status === "pass").length;
  const check = state.items.filter(i => i.status === "check").length;
  const fail = state.items.filter(i => i.status === "fail").length;
  $("statTotal").textContent = total;
  $("statPass").textContent = pass;
  $("statCheck").textContent = check;
  $("statFail").textContent = fail;
}

// ---------- export ----------
function download(filename, contents, mime = "text/plain") {
  const blob = new Blob([contents], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function timestamp() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function exportCsv() {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["ID","Verified","Status","Score","Parsed Title","Parsed Authors","DB Title","DB Authors","Parsed DOI","Matched DOI","Source"].join(";");
  const rows = state.items.map(i => [i.id, i.verified, i.status, i.matchScore, i.title, i.authors, i.dbTitle, i.dbAuthors, i.doi, i.dbDoi, i.source].map(esc).join(";"));
  download(`cerca_results_${timestamp()}.csv`, [head, ...rows].join("\n"), "text/csv");
}

function exportTxt() {
  const total = state.items.length;
  const verified = state.items.filter(i => i.verified).length;
  const review = total - verified;
  const lines = [];
  lines.push("CERCA Web - INTEGRITY DIAGNOSTIC REPORT");
  lines.push(`Generated: ${new Date().toISOString().replace("T", " ").slice(0, 16)}`);
  lines.push("* DISCLAIMER: Experimental tool. Always verify against the original source.");
  lines.push("=".repeat(50));
  lines.push("");
  lines.push("SUMMARY");
  lines.push("-".repeat(7));
  lines.push(`Total References: ${total}`);
  lines.push(`Verified:         ${verified}`);
  lines.push(`Review Needed:    ${review}`);
  lines.push("");
  lines.push("=".repeat(50));
  lines.push("DIAGNOSTICS: ITEMS REQUIRING ATTENTION");
  lines.push("=".repeat(50));
  for (const it of state.items.filter(i => !i.verified)) {
    lines.push("");
    lines.push(`#${it.id}`);
    const diag = it.status === "fail" ? "NO MATCH FOUND." : "LOW CONFIDENCE MATCH. Verify spelling or formatting.";
    lines.push(`DIAGNOSIS: ${diag}`);
    lines.push("-".repeat(50));
    lines.push(`   Parsed Title:   ${it.title}`);
    lines.push(`   Parsed Authors: ${it.authors}`);
    lines.push(`   DB Title:       ${it.dbTitle}`);
    lines.push(`   DB Authors:     ${it.dbAuthors}`);
    lines.push(`   Score:          ${it.matchScore}`);
    lines.push(`   DOI:            ${it.dbDoi || it.doi}`);
    lines.push(`   Source:         ${it.source}`);
  }
  lines.push("");
  lines.push("=".repeat(50));
  lines.push("End of Report");
  download(`cerca_report_${timestamp()}.txt`, lines.join("\n"));
}

// ---------- wire up ----------
$("loadBtn").addEventListener("click", loadFromTextarea);
$("verifyBtn").addEventListener("click", verifyAll);
$("csvBtn").addEventListener("click", exportCsv);
$("txtBtn").addEventListener("click", exportTxt);
$("clearBtn").addEventListener("click", () => {
  $("input").value = "";
  state.items = [];
  $("verifyBtn").disabled = true;
  $("csvBtn").disabled = true;
  $("txtBtn").disabled = true;
  setStatus("");
  render();
});
render();
