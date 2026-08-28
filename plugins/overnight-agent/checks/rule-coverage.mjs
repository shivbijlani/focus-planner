#!/usr/bin/env node
/**
 * rule-coverage.mjs — how many of the agent's WRITTEN rules have EXECUTABLE enforcement?
 *
 * ⚠️⚠️ THE NUMBER THIS PRINTS IS NOT TRUSTWORTHY. DO NOT QUOTE IT AS A HEALTH METRIC. ⚠️⚠️
 *
 * This is a one-off diagnostic, deliberately excluded from `run-sweeps.ps1`. Read the
 * METHOD section before believing any figure it produces:
 *
 *   - The FIRST cut of this script reported 157/157 = **100% covered**, which is a false
 *     green of exactly the kind this codebase keeps getting burned by. The enforcement
 *     corpus included COMMENTS, and these sweeps carry very long comment headers that
 *     RESTATE their rule in prose (`run-sweeps.ps1` alone has ~100 lines of it). Every
 *     rule was matching its own quotation and certifying itself as enforced.
 *   - Stripping comments moved it only to **99%**, which is still far too generous: the
 *     match rule is "one distinguishing term appears anywhere in 107 files", and that is
 *     not evidence a rule is enforced.
 *
 * The durable finding from building it is the FALSE GREEN itself, plus the raw counts
 * (~159 written rules, 546 KB, ~86k words, against 37 executable checks). Those are
 * measured and quotable. The coverage percentage is not.
 *
 * A trustworthy version would need each rule to DECLARE its enforcer, which means
 * annotating the rules rather than guessing from keywords. That is the honest next step
 * and it has not been taken.
 */

/*
 * WHY THIS EXISTS
 * ---------------
 * Shiv, 2026-08-27 on task #448: "is there a way to fix this in a way [that is] programmatic
 * forward - that way things are codified a bit, instead of being written up in a skill?"
 *
 * `user-settings.md` is ~560 KB / ~86k words and contains ~149 explicit `**Rule: ...**`
 * statements. The file itself repeatedly records that a prose rule is not enough:
 *   - the PHASE 3 banner exists "because the rule kept getting broken while it lived
 *     further down the file" (3 identical failures in one day),
 *   - the sweeps wrapper exists for the "same rationale: a prose warning in this file was
 *     not enough",
 *   - the ask-format rule had to be restated by Shiv the SAME DAY it was written down.
 *
 * Meanwhile every rule that was turned into an executable artifact -- a wrapper that makes
 * the wrong call impossible (`run-telegram-mirror.ps1`, `run-sweeps.ps1`), a guard inside
 * `oa-state.ps1`, or a nightly sweep -- has not regressed since.
 *
 * So the question is measurable: WHICH rules still have nothing but prose behind them?
 * That set is the backlog for "codify it going forward".
 *
 * METHOD
 * ------
 * A rule is counted as COVERED when one of its distinguishing signature terms appears in
 * the enforcement corpus (the executable scripts, guards and sweeps). Matching is
 * deliberately GENEROUS -- a term appearing anywhere in executable code counts. That biases
 * the result toward "covered", so the uncovered count is a LOWER BOUND on the real gap.
 * An over-estimate of the gap would be easy to dismiss; an under-estimate cannot be.
 *
 * Signature terms are the rule's backticked identifiers and its rare words (words that
 * appear in few rules), because those are what an enforcer would have to name. Ubiquitous
 * vocabulary ("task", "journal", "agent") is excluded: it matches everything and would
 * certify every rule as covered.
 *
 * Usage:  node rule-coverage.mjs [--json] [--list-covered]
 *         PLANNER_PATH must point at the folder holding user-settings.md.
 */

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const OA = path.join(process.env.LOCALAPPDATA || '', 'overnight-agent');
const SKILL = 'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent';
const SETTINGS = path.join(PLANNER, 'user-settings.md');

const asJson = process.argv.includes('--json');
const listCovered = process.argv.includes('--list-covered');

// --- 1. the enforcement corpus -------------------------------------------------------
// Executable artifacts only. A rule restated inside another .md file is still prose, so
// markdown is deliberately NOT part of the corpus -- that is the entire distinction being
// measured. Backups (*.bak*) are excluded: dead code enforces nothing.
//
// ⚠️ COMMENTS ARE STRIPPED, and this is the single most important line in the file.
// The first cut of this script kept them and reported 157/157 = 100% COVERED, which is a
// false green of exactly the kind this codebase keeps getting burned by. These sweeps
// carry very long comment headers that RESTATE their rule in prose -- `run-sweeps.ps1`
// alone has ~100 lines of it. So every rule matched its own quotation and certified
// itself as enforced. A comment is prose that happens to live in a .ps1 file; it executes
// nothing and prevents nothing. Only code counts.
//
// String literals are deliberately KEPT: a sweep's regexes and match terms are its actual
// enforcement mechanism, and they live in strings.
function stripComments(text, kind) {
  if (kind === 'ps1') {
    return text
      .replace(/<#[\s\S]*?#>/g, ' ')          // block comments
      .replace(/(^|\s)#[^\r\n]*/g, '$1 ');    // line comments (leading-# or after whitespace)
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 '); // line comments, not the // in a URL
}

function collectCorpus() {
  const files = [];
  for (const dir of [OA, SKILL]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(mjs|js|ps1)$/i.test(name)) continue;
      if (/\.bak|backup|\.pre-/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const raw = fs.readFileSync(full, 'utf8');
        const kind = /\.ps1$/i.test(name) ? 'ps1' : 'js';
        files.push({ name, text: stripComments(raw, kind), raw });
      } catch { /* unreadable -> not an enforcer */ }
    }
  }
  return files;
}

// --- 2. extract the rules ------------------------------------------------------------
// A rule is `**Rule: ...**` / `**Rules: ...**` / `**Fallback rule: ...**`. Capture the bold
// span, which is the operative sentence; the prose after it is commentary.
function extractRules(text) {
  const lines = text.split(/\r?\n/);
  const offsets = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }
  const lineOf = (idx) => {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  const re = /\*\*((?:Fallback rule|Rules?)\b[:\s][^*]{10,400}?)\*\*/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].replace(/\s+/g, ' ').trim();
    out.push({ line: lineOf(m.index), text: body, index: m.index });
  }
  return out;
}

// --- 3. signature terms --------------------------------------------------------------
const STOP = new Set(`
the a an and or but if then than that this these those is are was were be been being do does did
not no never always only just also very more most much many some any each every all both either
you your yours i me my we our us it its they them their he she his her
to of in on at by for with from into onto over under about against between during before after
above below up down out off again further once here there when where why how what which who whom
rule rules task tasks journal journals agent agents user users shiv run runs ran running
so as it's dont don't cannot can could should would may might must will shall
one two three first second third next last new old same other another
read reads reading write writes writing check checks checking make makes made take takes
thing things something anything nothing way ways time times day days
because since while until unless whether though although however therefore thus hence
file files line lines text word words note notes case cases
`.trim().split(/\s+/));

function termsOf(ruleText) {
  const terms = new Set();
  // backticked identifiers are the strongest signal: an enforcer must name them
  for (const m of ruleText.matchAll(/`([^`]{2,60})`/g)) {
    const t = m[1].trim().toLowerCase();
    if (t.length >= 3) terms.add(t);
  }
  // rare-ish words
  for (const m of ruleText.matchAll(/[A-Za-z][A-Za-z-]{4,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) terms.add(w);
  }
  return [...terms];
}

// --- 4. classify ---------------------------------------------------------------------
function main() {
  if (!fs.existsSync(SETTINGS)) { console.error(`settings not found: ${SETTINGS}`); process.exit(2); }
  const settings = fs.readFileSync(SETTINGS, 'utf8');
  const corpus = collectCorpus();
  const corpusLower = corpus.map(f => ({ name: f.name, text: f.text.toLowerCase() }));

  const rules = extractRules(settings);

  // Document frequency across rules -> drop vocabulary that is ambient rather than
  // identifying. A term in >12% of rules describes the domain, not this rule.
  const df = new Map();
  const perRuleTerms = rules.map(r => termsOf(r.text));
  for (const ts of perRuleTerms) for (const t of new Set(ts)) df.set(t, (df.get(t) || 0) + 1);
  const dfCap = Math.max(3, Math.ceil(rules.length * 0.12));

  const results = [];
  rules.forEach((r, i) => {
    const sig = perRuleTerms[i].filter(t => (df.get(t) || 0) <= dfCap);
    const hits = [];
    for (const t of sig) {
      for (const f of corpusLower) {
        if (f.text.includes(t)) { hits.push({ term: t, file: f.name }); break; }
      }
    }
    const byFile = new Map();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    results.push({
      line: r.line,
      text: r.text.length > 190 ? r.text.slice(0, 187) + '...' : r.text,
      signatureTerms: sig.length,
      matchedTerms: hits.length,
      covered: hits.length > 0,
      enforcers: top.map(([f, n]) => `${f}(${n})`),
    });
  });

  // A rule with no usable signature can't be judged either way -- report separately rather
  // than silently counting it as a gap. Otherwise the headline number is inflated by the
  // measurement's own blind spot.
  const unjudgeable = results.filter(r => r.signatureTerms === 0);
  const judged = results.filter(r => r.signatureTerms > 0);
  const covered = judged.filter(r => r.covered);
  const uncovered = judged.filter(r => !r.covered);

  const summary = {
    settingsBytes: settings.length,
    settingsWords: settings.split(/\s+/).length,
    corpusFiles: corpus.length,
    rulesFound: rules.length,
    judged: judged.length,
    covered: covered.length,
    uncovered: uncovered.length,
    unjudgeable: unjudgeable.length,
    coveragePct: judged.length ? Math.round((covered.length / judged.length) * 100) : 0,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, uncovered, covered: listCovered ? covered : undefined }, null, 2));
    return process.exit(uncovered.length ? 1 : 0);
  }

  console.log(`rule-coverage: ${summary.rulesFound} written rules in user-settings.md ` +
    `(${(summary.settingsBytes / 1024).toFixed(0)} KB, ~${summary.settingsWords.toLocaleString()} words)`);
  console.log(`  enforcement corpus : ${summary.corpusFiles} executable files`);
  console.log(`  judged             : ${summary.judged}`);
  console.log(`  HAS code behind it : ${summary.covered}  (${summary.coveragePct}%)`);
  console.log(`  PROSE ONLY         : ${summary.uncovered}`);
  console.log(`  unjudgeable        : ${summary.unjudgeable} (no distinguishing terms)`);
  console.log('');
  console.log('--- prose-only rules (no executable enforcement found) ---');
  for (const r of uncovered) console.log(`  L${String(r.line).padStart(5)}  ${r.text}`);
  if (listCovered) {
    console.log('');
    console.log('--- covered ---');
    for (const r of covered) console.log(`  L${String(r.line).padStart(5)}  [${r.enforcers.join(' ')}] ${r.text}`);
  }
  process.exit(uncovered.length ? 1 : 0);
}

main();
