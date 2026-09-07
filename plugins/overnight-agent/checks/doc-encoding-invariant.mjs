// doc-encoding-invariant.mjs
//
// GUARDS: a catch-up doc must not contain double-encoded (mojibake) text.
//
// WHY THIS EXISTS
//
// Issue #549. On 2026-09-05 task #471's first catch-up doc was built by reading a UTF-8
// markdown file with a bare `Get-Content -Raw` and pushing the string at the Docs API.
// Windows PowerShell 5.1 -- which is what `powershell -NoProfile -File ...` resolves to,
// and that is how every documented command in this project is invoked -- decodes a
// no-BOM file as the ANSI codepage. The API then encodes that string as UTF-8 a second
// time, and the document permanently contains the double-encoded form.
//
// Reproduced on this box 2026-09-07:
//
//     powershell 5.1  Get-Content -Raw            -> "emâ€”dash ... GÃ¶reme NevÅŸehir"
//     powershell 5.1  Get-Content -Raw -Encoding UTF8 -> "em—dash ... Göreme Nevşehir"
//     pwsh 7          Get-Content -Raw            -> "em—dash ... Göreme Nevşehir"
//
// Note the third line, because it is the reason this went unnoticed: the defect is
// INVISIBLE from a pwsh 7 shell, which is what an interactive session gets. It fires
// only in the runtime the scheduled work actually uses. A check that runs in the
// convenient shell agrees with the broken one.
//
// WHY A SOURCE LINT CANNOT COVER THIS -- the issue's own note, and it is correct:
//
//   "A guard that only checks the body being written would not have caught this,
//    because the body on disk was valid -- the corruption happened in the read.
//    Whatever is built should compare what is in the DESTINATION against what is in
//    the source, not lint the source alone."
//
// So this reads the destination. The doc is fetched back and inspected. That also makes
// it indifferent to which code path did the damage, which matters because the doc write
// path is not a script: it is an agent issuing `mcp-probe` calls ad hoc. There is no
// single function to fix, so there must be a check on the result.
//
// WHY IT IS A THIRD CLASS IN AN EXISTING FAMILY
//
// The same corruption is already guarded on two surfaces and on neither of them was
// prose enough:
//   * journal-encoding-invariant.mjs -- the journal surface (HAZARD 4)
//   * ps1-encoding-sweep.mjs         -- .ps1 source files
// The catch-up doc is the third surface and had nothing, which is exactly #549's title.
// Per #468 the doc is "the primary communication mechanism", so silent corruption on
// its write path is a reliability defect, not a cosmetic one.
//
// PRECISION OVER RECALL, DELIBERATELY
//
// Every signature below is a TWO-character sequence that ordinary prose does not
// produce, not a single suspicious letter. A detector that fires on well-formed text
// gets switched off, and then the surface is unguarded again while appearing guarded --
// the failure shape this whole family exists to remove. Missing an exotic case is
// recoverable; crying wolf on the primary surface is not.
//
// exit 1 = findings (a doc is corrupted). exit 0 = every doc read came back clean.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The detector. Pure: no clock, no IO, no env. Mutation arms import this
// directly and run anywhere, including a Linux CI box with no Google account.
// ---------------------------------------------------------------------------

// How each signature arises: take the real character, encode UTF-8, then decode those
// bytes as cp1252. The FIRST TWO characters of the result are the fingerprint.
//
//   U+2014 em-dash  -> E2 80 94 -> "â" "€" "”"   => prefix \u00E2\u20AC
//   U+1F319 moon    -> F0 9F 8C 99 -> "ð" "Ÿ" .. => prefix \u00F0\u0178
//   U+015F  ş       -> C5 9F    -> "Å" "Ÿ"       => prefix \u00C5\u0178
//   U+00F6  ö       -> C3 B6    -> "Ã" "¶"       => prefix \u00C3 + C1-continuation
// Twice a day per doc, 8 docs a run. Enough that a corruption is seen the same night,
// small enough that 81 bound docs never become 81 API calls in one run (#586, #590).
export const FRESH_MINUTES = Number(process.env.OA_DOC_BODY_FRESH_MINUTES) || 720;
export const DEFAULT_LIMIT = Number(process.env.OA_DOC_BODY_LIMIT) || 8;

export const SIGNATURES = [
  {
    name: 'punctuation',
    // Covers every U+20xx character at once: em/en dash, curly quotes, ellipsis,
    // bullet. All of them share the E2 80 lead bytes, hence this exact prefix.
    re: /\u00E2\u20AC/g,
    means: 'double-encoded U+20xx punctuation (em-dash, curly quote, ellipsis)',
  },
  {
    name: 'emoji',
    // 4-byte astral characters: the moon heading glyph, the board urgency glyphs.
    re: /\u00F0\u0178/g,
    means: 'double-encoded 4-byte emoji',
  },
  {
    name: 'latin1',
    // Accented Latin: ö ü é à. "Ã" followed by a character from the Latin-1
    // punctuation/symbol block does not occur in well-formed prose.
    re: /\u00C3[\u0080-\u00BF]/g,
    means: 'double-encoded accented Latin character',
  },
  {
    name: 'turkish',
    // ş ğ and friends, the characters named in the original #549 report.
    re: /\u00C5\u0178/g,
    means: 'double-encoded Turkish character',
  },
];

/**
 * Find double-encoding fingerprints in already-decoded text.
 * Returns [] for clean text. Never throws on odd input.
 */
export function findMojibake(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const sig of SIGNATURES) {
    const re = new RegExp(sig.re.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({
        signature: sig.name,
        means: sig.means,
        index: m.index,
        sample: text.slice(Math.max(0, m.index - 25), m.index + 25).replace(/\s+/g, ' '),
      });
      if (hits.length >= 200) return hits; // a wholly-corrupt doc needs no further proof
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Choose which bound docs to body-check this run. Pure.
 * Docs checked inside `freshMinutes` are not candidates at all, so repeated runs
 * converge to quiet instead of re-fetching every doc forever (rate limits: #586, #590).
 * Never-checked first, then oldest, ties broken by numeric id for reproducibility.
 */
export function selectTargets(rows, { limit = DEFAULT_LIMIT, freshMinutes = FRESH_MINUTES, now = Date.now() } = {}) {
  const freshMs = Math.max(0, freshMinutes) * 60 * 1000;
  const cand = [];
  for (const r of rows || []) {
    if (!r || !r.docId) continue;
    const t = r.checkedAt ? Date.parse(r.checkedAt) : NaN;
    const ageMs = Number.isFinite(t) ? now - t : Infinity;
    if (ageMs < freshMs) continue;
    cand.push({ ...r, ageMs });
  }
  cand.sort((a, b) => (b.ageMs - a.ageMs) || (Number(a.id) - Number(b.id)));
  return cand.slice(0, Math.max(0, limit));
}

/**
 * Classify one doc read. Pure.
 * A failed fetch is its own outcome. Folding it into 'clean' would make a run that
 * could not reach Google indistinguishable from a run that read everything and found
 * nothing -- the exact "a step nothing verifies looks like a step with nothing to do"
 * defect this family of checks exists to remove.
 */
export function classify(readOk, hits) {
  if (!readOk) return 'UNREADABLE';
  return (hits && hits.length) ? 'CORRUPT' : 'clean';
}

/**
 * May this doc's check time be stamped? Pure.
 * Only a clean read earns a stamp. Stamping a corrupt doc would push it outside the
 * freshness window, so the finding would vanish from the next run's report while the
 * document stayed corrupt -- a finding that silences itself.
 */
export function shouldStampChecked(verdict) {
  return verdict === 'clean';
}

export const ageLabel = (ms) =>
  !Number.isFinite(ms) ? 'never' : ms < 60000 ? 'just now' : `${Math.round(ms / 60000)}min ago`;

// ---------------------------------------------------------------------------
// Effects. Guarded so the mutation check can import the pure parts safely.
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const STATE_DIR =
    process.env.OA_STATE_DIR ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');
  if (!STATE_DIR) {
    console.error('No state dir: set OA_STATE_DIR (or run on Windows, where LOCALAPPDATA is set).');
    process.exit(2);
  }

  const PROBE =
    process.env.OA_MCP_PROBE ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-probe.mjs');
  const EMAIL = process.env.OA_GOOGLE_EMAIL || 'shiv@bijlanis.com';
  const CHECKED_FILE = path.join(STATE_DIR, 'doc-encoding-checked.json');
  const TERMINAL = new Set(['done', 'skip', 'cancelled']);
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };

  const checked = readJson(CHECKED_FILE) || {};

  const rows = [];
  for (const f of fs.readdirSync(STATE_DIR)) {
    const m = /^task-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const id = m[1];
    const st = readJson(path.join(STATE_DIR, f));
    if (!st) continue;
    const doc = st.catchup_doc || st.doc || {};
    const docId = doc.doc_id || '';
    if (!docId) continue;
    if (TERMINAL.has(String(st.status || ''))) continue;
    rows.push({ id, docId, checkedAt: checked[docId] || '' });
  }

  const targets = selectTargets(rows, { limit });

  console.log(`state dir   : ${STATE_DIR}`);
  console.log(`bound docs  : ${rows.length}`);
  console.log(`stale bodies: ${rows.filter((r) => !r.checkedAt).length} never checked`);
  console.log(`selected    : ${targets.length} (cap ${limit}, fresh window ${FRESH_MINUTES}min)`);
  if (dryRun) {
    for (const t of targets) console.log(`  would read  task ${t.id}  doc ${t.docId}  last checked ${ageLabel(t.ageMs)}`);
    process.exit(0);
  }

  const findings = [];
  let read = 0;
  let failed = 0;

  for (const t of targets) {
    // The subject is evidence, not caption: name what was actually resolved, in the
    // same block as its result, so a result can never be read against the wrong doc.
    const subject = `task ${t.id}  doc ${t.docId}  last checked ${ageLabel(t.ageMs)}`;
    const args = JSON.stringify({ document_id: t.docId, user_google_email: EMAIL });
    const r = spawnSync(process.execPath, [PROBE, 'google-workspace', 'call', 'get_doc_as_markdown', args], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    });

    let body = null;
    if (r.status === 0) {
      try {
        // get_doc_as_markdown returns the body twice; structuredContent.result is the
        // authoritative copy. Parsing the other one silently halves the coverage.
        body = JSON.parse(String(r.stdout || '')).structuredContent?.result ?? null;
      } catch {
        body = null;
      }
    }

    if (typeof body !== 'string') {
      // A failed fetch is NOT a clean doc. Conflating "could not read" with "read and
      // found nothing" is the #346 shape and is the precise defect this file guards.
      failed++;
      console.log(`  ${classify(false, [])}  ${subject}`);
      continue;
    }

    read++;
    const hits = findMojibake(body);
    const verdict = classify(true, hits);

    if (verdict === 'clean') {
      console.log(`  clean       ${subject}  (${body.length} chars)`);
      if (shouldStampChecked(verdict)) checked[t.docId] = new Date().toISOString();
      continue;
    }

    const byKind = {};
    for (const h of hits) byKind[h.signature] = (byKind[h.signature] || 0) + 1;
    const kinds = Object.entries(byKind).map(([k, n]) => `${k} x${n}`).join(', ');
    console.log(`  CORRUPT     ${subject}`);
    console.log(`              ${hits.length} fingerprint(s): ${kinds}`);
    console.log(`              first at char ${hits[0].index}: ...${hits[0].sample}...`);
    findings.push(
      `task ${t.id} doc ${t.docId} contains ${hits.length} double-encoding fingerprint(s) (${kinds}). ` +
        `Repair by PATCHing raw bytes to the SAME document id - never delete and recreate, which ` +
        `orphans the binding and strands the comments (#423).`
    );
    // A corrupt doc stays a candidate every run until someone repairs it, so the
    // finding cannot age out of the report while the document is still broken.
    if (shouldStampChecked(verdict)) checked[t.docId] = new Date().toISOString();
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CHECKED_FILE, JSON.stringify(checked, null, 2), 'utf8');
  } catch (e) {
    console.log(`  note: could not persist check times (${e.message})`);
  }

  console.log(`\nread ${read}, unreadable ${failed}, corrupt ${findings.length}`);

  if (findings.length) {
    console.log(`\nFINDINGS: ${findings.length}`);
    for (const f of findings) console.log(`  - ${f}`);
    process.exit(1);
  }
  if (read === 0 && targets.length > 0) {
    console.log('\nFINDINGS: 1');
    console.log('  - every selected doc was unreadable, so this run proves nothing about encoding.');
    process.exit(1);
  }
  console.log('\nno findings: every catch-up doc read this run is free of double-encoding.');
}
