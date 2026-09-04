// pr-closing-keyword.mjs -- refuse a PR body that will auto-close its issue on merge (GH #428).
//
// WHY THIS EXISTS
// ---------------
// The operating contract on task #463 is explicit:
//
//   > A shipped PR does not close the issue. I review the catch-up doc, ask follow-ups,
//   > and tell you when to close.
//
// The issue staying open IS the signal that something is waiting for Shiv. A closing keyword
// in a PR body silently deletes that signal on merge: the issue drops off his review surface,
// reads as "finished" when it is actually "shipped, unreviewed", and takes the one agentic
// comment down with it.
//
// It has now happened twice:
//   * PR #427 carried a literal `Closes #422.` -> issue #422 closed unreviewed.
//   * PR #443 carried NO literal `Closes #N` at all. It carried a sentence written
//     specifically to promise the opposite:
//
//         **This does not close [issue #441](https://github.com/.../issues/441)**
//
//     GitHub resolves a closing keyword followed by a markdown LINK by its href, so the
//     disclaimer was itself a closing reference. Verified after the fact with GitHub's own
//     parse: `gh pr view 443 --json closingIssuesReferences` returns #441.
//
// That second case is the whole argument for this file. The author knew the rule, wrote the
// rule down inside the PR, and still tripped it -- because "avoid a closing keyword" was being
// evaluated by a human against a grammar only GitHub actually knows.
//
// SO THE AUTHORITATIVE CHECK IS NOT A REGEX
// -----------------------------------------
// `closingIssuesReferences` is GitHub telling us what IT parsed. It cannot drift from GitHub's
// behaviour, because it IS GitHub's behaviour. We ask it whenever we can, and the local grammar
// below is the offline floor plus the thing that says WHERE the problem is.
//
// When GitHub finds a reference the local grammar missed, that is reported as its own failure
// (`drift`): a silent miss here is exactly the defect this guard exists to prevent, so the
// grammar is never allowed to quietly fall behind.
//
//   node pr-closing-keyword.mjs --body-file <file> [--labels a,b] [--pr N] [--repo owner/repo]
//   node pr-closing-keyword.mjs --from-env        # PR_BODY / PR_LABELS / PR_NUMBER / GH_REPO
//   node pr-closing-keyword.mjs --body-file <f> --no-remote   # offline (grammar only)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// GitHub's documented closing keywords. Widening this list makes the guard fire on ordinary
// prose; narrowing it lets a real closer through. Both directions are covered by mutation arms.
export const CLOSING_KEYWORDS = [
  'close', 'closes', 'closed',        // KW:close
  'fix', 'fixes', 'fixed',            // KW:fix
  'resolve', 'resolves', 'resolved',  // KW:resolve
];

// A PR that genuinely should close its own issue opts out with a label, so the exception is
// visible in the timeline rather than invisible in someone's prose.
export const OPT_OUT_LABEL = 'allow-auto-close';

// The reference forms GitHub accepts after a closing keyword. `mdlink` is the one that closed
// #441 and the one a hand-rolled check will always forget, because it is invisible in the
// rendered text -- the href does the work.
const REF_FORMS = [
  String.raw`#\d+`,                                                                       // REF:hash
  String.raw`GH-\d+`,                                                                     // REF:gh
  String.raw`[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+`,                                       // REF:cross
  String.raw`<?https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+[^\s>)]*>?`, // REF:url
  String.raw`\[[^\]\n]*\]\(\s*https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+[^)]*\)`, // REF:mdlink
];

/** Replace a span with spaces, preserving newlines so line numbers stay truthful. */
function blank(text, start, end) {
  const span = text.slice(start, end).replace(/[^\n]/g, ' ');
  return text.slice(0, start) + span + text.slice(end);
}

function maskEach(text, rx) {
  let out = text;
  for (const m of [...text.matchAll(rx)]) out = blank(out, m.index, m.index + m[0].length);
  return out;
}

/** ``` / ~~~ fenced blocks -- GitHub does not linkify inside them. */
export function maskFenced(text) {
  return maskEach(text, /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$)/gm);
}

/**
 * Inline code spans. `Closes #N` inside backticks is documentation, not an instruction.
 *
 * The lookarounds are load-bearing. Without them a lone odd run -- a sentence mentioning
 * ``` mid-prose, say -- lets the engine backtrack into a PARTIAL run, which re-pairs every
 * backtick after it and exposes the contents of later, perfectly well-formed spans. Found by
 * running this guard against its own PR body, which flagged a `Closes #446` that was correctly
 * inside backticks. CommonMark closes a run of N backticks only with a run of exactly N.
 */
export function maskInlineCode(text) {
  return maskEach(text, /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g);
}

/** Blockquoted lines -- quoting someone else's closing keyword must not close anything. */
export function maskBlockquotes(text) {
  return maskEach(text, /^[ \t]*>[^\n]*$/gm);
}

export function maskExempt(text) {
  let t = text;
  t = maskFenced(t);       // MASK:fenced
  t = maskInlineCode(t);   // MASK:inline
  t = maskBlockquotes(t);  // MASK:quote
  return t;
}

function keywordRefPattern() {
  const kw = CLOSING_KEYWORDS.join('|');
  const ref = REF_FORMS.join('|');
  // keyword, optional colon, whitespace, then one reference form.
  return new RegExp(String.raw`\b(${kw})\b\s*:?\s+(${ref})`, 'gi');
}

/**
 * Findings in a PR body, by the local grammar. Offsets are into the ORIGINAL text, so the
 * reported line number points at what the author actually wrote.
 */
export function scanBody(body) {
  const masked = maskExempt(body ?? '');
  const findings = [];
  for (const m of masked.matchAll(keywordRefPattern())) {
    const before = body.slice(0, m.index);
    findings.push({
      line: before.split('\n').length,
      keyword: m[1],
      ref: m[2].trim(),
      text: body.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(),
    });
  }
  return findings;
}

/** Ask GitHub what IT parsed. Returns null when it cannot be asked (never a false "clean"). */
export function remoteClosingRefs(pr, repo) {
  if (!pr) return null;
  try {
    const args = ['pr', 'view', String(pr), '--json', 'closingIssuesReferences'];
    if (repo) args.push('--repo', repo);
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
    });
    const parsed = JSON.parse(out);
    return (parsed.closingIssuesReferences ?? []).map((o) => o.number);
  } catch {
    return null; // unreadable -- the local grammar is still the floor
  }
}

/**
 * `remoteRefs` may be supplied by a caller that already has GitHub's answer (the guard's
 * fixtures do this, so the drift path is exercised without a network).
 */
export function evaluate({ body, labels = [], pr = null, repo = null, remote = true, remoteRefs: given = null }) {
  const lower = labels.map((l) => String(l).toLowerCase().trim());
  if (lower.includes(OPT_OUT_LABEL)) {                                   // OPTOUT
    return { ok: true, optedOut: true, findings: [], remoteRefs: null, drift: [] };
  }
  const findings = scanBody(body);
  const remoteRefs = given ?? (remote ? remoteClosingRefs(pr, repo) : null);
  // A number GitHub will close that the grammar did not see is its own, louder failure.
  const seen = new Set(findings.map((f) => (f.ref.match(/(\d+)(?!.*\d)/) || [])[1]).filter(Boolean));
  const drift = (remoteRefs ?? []).filter((n) => !seen.has(String(n)));   // DRIFT
  return {
    ok: findings.length === 0 && (remoteRefs ?? []).length === 0,
    optedOut: false,
    findings,
    remoteRefs,
    drift,
  };
}

// ---------------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const fromEnv = process.argv.includes('--from-env');
  const body = fromEnv
    ? (process.env.PR_BODY ?? '')
    : readFileSync(arg('--body-file'), 'utf8');
  const labels = (fromEnv ? (process.env.PR_LABELS ?? '') : (arg('--labels') ?? ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const pr = fromEnv ? (process.env.PR_NUMBER ?? null) : arg('--pr');
  const repo = fromEnv ? (process.env.GH_REPO ?? null) : arg('--repo');
  const remote = !process.argv.includes('--no-remote');

  const r = evaluate({ body, labels, pr, repo, remote });

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  }

  if (r.optedOut) {
    console.log(`[pr-closing-keyword] opted out via the '${OPT_OUT_LABEL}' label -- this PR may close its issue.`);
    process.exit(0);
  }
  if (r.remoteRefs === null && pr) {
    console.log('[pr-closing-keyword] note: GitHub could not be asked; using the local grammar only.');
  }
  if (r.ok) {
    const asked = r.remoteRefs === null ? '' : ` GitHub parsed ${r.remoteRefs.length} closing reference(s).`;
    console.log(`[pr-closing-keyword] OK -- this PR body will not auto-close an issue.${asked}`);
    process.exit(0);
  }

  console.error('');
  console.error('FAIL: this PR body will auto-close an issue on merge.');
  console.error('');
  console.error('  A shipped PR does not close its issue -- the issue staying open is how Shiv');
  console.error('  knows something is waiting for his review (GH #428).');
  console.error('');
  for (const f of r.findings) {
    console.error(`  line ${f.line}: ${f.text}`);
  }
  for (const n of r.drift) {
    console.error(`  GitHub will close #${n} -- and the local grammar did NOT see it.`);
    console.error('  That is a grammar drift, not just a slip: update REF_FORMS in this file.');
  }
  console.error('');
  console.error(`  Fix: write 'Refs #N' or 'Part of #N' instead of a closing keyword.`);
  console.error(`  Careful: a keyword followed by a markdown LINK to an issue also closes it,`);
  console.error(`  so "does not close [issue #441](.../issues/441)" is a closing reference.`);
  console.error(`  Genuinely self-closing PR? Add the '${OPT_OUT_LABEL}' label.`);
  console.error('');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pr-closing-keyword.mjs')) {
  main();
}
