#!/usr/bin/env node
/**
 * mutcheck-observe-bound-docs.mjs -- proves the #598 fix is load-bearing.
 *
 * ACCEPTANCE CRITERION #3 OF #598, AND WHY IT IS THE ONE THAT MATTERS
 * ------------------------------------------------------------------
 * The issue asked for "a mutation arm that skips the observe-on-bind step [and] FAILS, rather
 * than passing because the count was already zero". That criterion exists because the other two
 * are satisfiable by a fix that does nothing:
 *
 *   - criterion #1 ("UNREAD: 0") is cleared by stamping `observed_at` at bind time, on a
 *     brand-new doc that truthfully has 0 comments. Green metric, unread mailbox.
 *   - criterion #2 needs periodic polling, but "polled" is invisible in a fleet that is quiet;
 *     a poller that silently selects nothing looks exactly like a fleet with nothing to poll.
 *
 * BOTH FAILURES ARE THE SAME SHAPE THIS TASK EXISTS TO KILL: a skipped step whose skip is
 * success-shaped. So every arm below is written to fail in the SKIP direction -- each mutant is
 * a plausible way for the poller to quietly stop polling something, and each must be caught by
 * an assertion that fails rather than by an absence of output.
 *
 * WHY `selectStale` IS THE SUBJECT
 * --------------------------------
 * It is pure -- no clock, no state store, no Google -- so this runs on the Linux CI runner where
 * LOCALAPPDATA does not exist and there are no credentials. The interesting failure modes are
 * all in the SELECTION rule (what gets polled, in what order, how many), not in the spawn calls,
 * so the part with the bugs is the part that is testable. Same discipline as
 * ensure-catchup-doc.mjs's `decide()`.
 *
 * The one arm that cannot be expressed against the pure function -- conflating an `unreadable`
 * observation with a successful read -- is checked as a source-level ABSENCE arm instead, since
 * that conflation is the single defect the whole channel exists to prevent.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, 'observe-bound-docs.mjs');

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`    ok   ${label}`);
  } else {
    failures++;
    console.log(`    FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
  return cond;
}

const NOW = Date.parse('2026-09-07T12:00:00Z');
const MIN = 60 * 1000;

// A fleet with one of each interesting kind. Ages are relative to NOW.
const rows = () => [
  { id: '100', status: 'in-progress', docId: 'dA', observedAt: new Date(NOW - 10 * MIN).toISOString() },  // fresh
  { id: '101', status: 'in-progress', docId: 'dB', observedAt: new Date(NOW - 400 * MIN).toISOString() }, // stale
  { id: '102', status: 'in-progress', docId: 'dC', observedAt: new Date(NOW - 900 * MIN).toISOString() }, // staler
  { id: '103', status: 'proposed', docId: 'dD', observedAt: '' },                                          // never
  { id: '104', status: 'done', docId: 'dE', observedAt: '' },                                              // terminal
  { id: '105', status: 'in-progress', docId: '', observedAt: '' },                                         // unbound
];

async function suite(modPath) {
  const { selectStale } = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const pick = (opts) => selectStale(rows(), { now: NOW, ...opts });

  const all = pick({ limit: 99 });
  const ids = all.map((r) => r.id);

  // A1 -- THE NEVER-OBSERVED CHANNEL IS POLLED. This is the NEVER_READ set (#215/#219/#220/
  // #221/#222 live). If a mutant treats "no timestamp" as "fine", the five tasks the issue was
  // filed on are exactly the five that never get read, and the metric still reads zero.
  check('A1 never-observed is selected', ids.includes('103'), `got [${ids}]`);

  // A2 -- AND IT IS SERVED FIRST. Worst-first ordering is what stops a channel starving behind
  // newer ones forever; a poller that is bounded but unordered can leave one task unread
  // indefinitely while reporting healthy throughput every run.
  check('A2 never-observed is first', ids[0] === '103', `got [${ids}]`);

  // A3 -- OLDEST BEFORE NEWER among observed channels.
  check('A3 oldest observed precedes newer', ids.indexOf('102') < ids.indexOf('101'), `got [${ids}]`);

  // A4 -- A FRESH CHANNEL IS NOT RE-POLLED. This is the self-limiting property: without it the
  // pass burns its whole Google budget re-reading channels it read minutes ago, which is how it
  // hits a rate limit (#586/#590) and then gets switched off.
  check('A4 fresh channel is skipped', !ids.includes('100'), `got [${ids}]`);

  // A5 -- TERMINAL AND UNBOUND ARE NOT POLLED. Binding is ensure-catchup-doc's job; a done task
  // has no channel worth money.
  check('A5 terminal and unbound excluded', !ids.includes('104') && !ids.includes('105'), `got [${ids}]`);

  // A6 -- THE CAP IS HONOURED. Unbounded is the same failure as unordered, arriving as a quota
  // error mid-pass instead of as starvation.
  check('A6 limit caps the pass', pick({ limit: 2 }).length === 2, `got ${pick({ limit: 2 }).length}`);

  // A7 -- A FULLY FRESH FLEET SELECTS NOTHING. The convergence property: the job must be able to
  // reach quiet, or it is an always-firing check.
  const allFresh = rows().map((r) => ({ ...r, observedAt: new Date(NOW - 5 * MIN).toISOString() }));
  check('A7 all-fresh fleet polls nothing', selectStale(allFresh, { now: NOW, limit: 99 }).length === 0);

  // ---- resolveOaState: the two-deploy-target path bug -------------------------------------
  // This file is copied into BOTH the plugin tree (checks/, with oa-state.ps1 two levels away at
  // ../skills/overnight-agent/) and the FLAT OA home (%LOCALAPPDATA%\overnight-agent\, with
  // oa-state.ps1 right beside it). run-sweeps.ps1 invokes the OA home copy, so a resolver that
  // only knows the plugin layout fails 100% of the time in the copy that actually runs -- which
  // is what happened: every observation this file ever attempted died on a path that does not
  // exist, and the per-task error made it read like 20 Google failures.
  const { resolveOaState } = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const sep = join('a', 'b').includes('\\') ? '\\' : '/';
  const homeHere = join('C:', 'la', 'overnight-agent');
  const pluginHere = join('C:', 'plug', 'overnight-agent', 'checks');
  const homeState = join(homeHere, 'oa-state.ps1');
  const pluginState = join(pluginHere, '..', 'skills', 'overnight-agent', 'oa-state.ps1');

  // B1 -- THE FLAT OA HOME LAYOUT RESOLVES. The regression itself. Without this arm the copy
  // that run-sweeps actually executes is the one nothing covers.
  check(
    'B1 OA home (flat) resolves to the co-located oa-state.ps1',
    resolveOaState({ here: homeHere, env: {}, exists: (p) => p === homeState }) === homeState,
    `got ${resolveOaState({ here: homeHere, env: {}, exists: (p) => p === homeState })}`
  );

  // B2 -- THE PLUGIN LAYOUT STILL RESOLVES. The fix must not trade one target for the other;
  // that would just move the 100% failure to the other copy.
  check(
    'B2 plugin tree still resolves via ../skills/overnight-agent',
    resolveOaState({ here: pluginHere, env: {}, exists: (p) => p === pluginState }) === pluginState,
    `got ${resolveOaState({ here: pluginHere, env: {}, exists: (p) => p === pluginState })}`
  );

  // B3 -- NOTHING FOUND RETURNS null, so the caller can say so ONCE and exit. Returning a
  // plausible-but-absent path is what produced 20 identical per-task failures that read as a
  // Google outage rather than as one missing file.
  check(
    'B3 unresolvable returns null',
    resolveOaState({ here: homeHere, env: {}, exists: () => false }) === null,
    'expected null so the caller can fail loudly once'
  );

  // B4 -- AN EXPLICIT OVERRIDE WINS, even when absent. An override that silently falls back to a
  // different file than the one named is worse than one that fails loudly.
  check(
    'B4 OA_STATE_PS1 overrides even when it does not exist',
    resolveOaState({ here: homeHere, env: { OA_STATE_PS1: 'X:\\pin\\oa-state.ps1' }, exists: () => true }) ===
      'X:\\pin\\oa-state.ps1',
    'the override must not be second-guessed by the probe'
  );
  void sep;

  // ---- classifyAttempts: recovered vs. persistent ------------------------------------------
  // Before the retry existed, ONE attempt decided everything, so a transport hiccup and a
  // genuinely broken page printed the identical FAIL line. That made a FAIL here worthless as
  // evidence -- and it fired for real on 2026-09-07, when task #475 was reported FAIL and read
  // clean on the very next poll. These arms pin the two properties that make FAIL mean
  // something: success only counts if the LAST attempt succeeded, and a recovery must be
  // reported as a recovery rather than laundered into a clean OK.
  const { classifyAttempts } = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);

  // C1 -- FIRST-TRY SUCCESS IS A PLAIN OK. The common path must not acquire a "recovered" label,
  // or the flaky-channel report becomes noise and stops being read.
  const c1 = classifyAttempts([{ ok: true, n: 2 }]);
  check('C1 first-attempt success is plain ok', c1.outcome === 'ok' && c1.n === 2 && c1.attempts === 1, `got ${JSON.stringify(c1)}`);

  // C2 -- SUCCESS AFTER FAILURE IS `recovered`, AND CARRIES THE FIRST REASON. This is the whole
  // point of the change: the read succeeded, so the channel is fine, but the fact that it needed
  // a second attempt is a real finding and is visible nowhere else.
  const c2 = classifyAttempts([{ ok: false, reason: 'fetch exited 1' }, { ok: true, n: 0 }]);
  check(
    'C2 success after failure is reported as recovered, with the first reason',
    c2.outcome === 'recovered' && c2.attempts === 2 && c2.firstReason === 'fetch exited 1' && c2.n === 0,
    `got ${JSON.stringify(c2)}`
  );

  // C3 -- FAILING TWICE IS A FAIL, AND SAYS SO. After this, a FAIL line is evidence of a
  // persistent problem, which is what makes it worth acting on.
  const c3 = classifyAttempts([{ ok: false, reason: 'observation: unreadable' }, { ok: false, reason: 'observation: unreadable' }]);
  check(
    'C3 two failures is a fail reporting the LAST reason and the attempt count',
    c3.outcome === 'fail' && c3.reason === 'observation: unreadable' && c3.attempts === 2,
    `got ${JSON.stringify(c3)}`
  );

  // C4 -- A LATER FAILURE IS NOT RESCUED BY AN EARLIER SUCCESS. Guards the obvious wrong
  // implementation (`attempts.some(a => a.ok)`), which would report a broken channel as read.
  const c4 = classifyAttempts([{ ok: true, n: 3 }, { ok: false, reason: 'fetch exited 1' }]);
  check('C4 verdict follows the LAST attempt, not any attempt', c4.outcome === 'fail', `got ${JSON.stringify(c4)}`);

  // C5 -- NO ATTEMPTS IS A FAIL, NOT A SILENT OK. A zero-attempt document must never be counted
  // as read; that would advance nothing and report everything.
  const c5 = classifyAttempts([]);
  check('C5 empty attempt list is a fail', c5.outcome === 'fail' && c5.attempts === 0, `got ${JSON.stringify(c5)}`);

  // C6 -- THE RETRY CANNOT BE DISABLED BACK TO ONE ATTEMPT. `OBSERVE_ATTEMPTS` floors at 2, so
  // an env value of 1 (or 0, or junk) cannot silently restore the defect this change removes.
  const { OBSERVE_ATTEMPTS } = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  check('C6 attempts floor at 2 so the defect cannot be re-enabled by env', OBSERVE_ATTEMPTS >= 2, `got ${OBSERVE_ATTEMPTS}`);

  return failures;
}

const MUTATIONS = [
  {
    id: 'M0a',
    what: 'the verdict follows ANY successful attempt rather than the LAST one',
    why: 'a document whose retry FAILED would be reported as read, so a persistently broken channel prints OK and the pass reports a number that parses as healthy. This is the single most attractive wrong implementation of a retry. Killed by C4.',
    find: '  const last = list[list.length - 1];',
    replace: '  const last = list.find((a) => a && a.ok) || list[list.length - 1];',
  },
  {
    id: 'M0b',
    what: 'a recovered read is reported as a plain OK, hiding that it needed a retry',
    why: 'THE DEFECT TRADED FOR A QUIETER ONE: the retry would still work, but an intermittent channel would become invisible instead of merely indistinguishable, so nobody ever learns the channel is unreliable. Killed by C2.',
    find: "    return list.length === 1\n      ? { outcome: 'ok', n: Number(last.n || 0), attempts: 1 }",
    replace: "    return true\n      ? { outcome: 'ok', n: Number(last.n || 0), attempts: 1 }",
  },
  {
    id: 'M0c',
    what: 'OBSERVE_ATTEMPTS loses its floor, so the env can set it back to 1',
    why: 'restores the original defect by configuration rather than by code -- a transient and a persistent failure print the identical FAIL line again, and the regression is invisible in the diff. Killed by C6.',
    find: 'export const OBSERVE_ATTEMPTS = Math.max(2, Number(process.env.OA_DOC_OBSERVE_ATTEMPTS) || 2);',
    replace: 'export const OBSERVE_ATTEMPTS = Number(process.env.OA_DOC_OBSERVE_ATTEMPTS) || 1;',
  },
  {
    id: 'M1',
    what: 'the freshness filter is removed, so every bound channel is polled every pass',
    why: 'the pass never converges: it maxes its cap forever, spends the Google budget re-reading fresh channels, and starves the stale ones it exists to serve. Killed by A4/A7.',
    find: '    if (ageMs < freshMs) continue;              // already fresh -- self-limiting\n',
    replace: '',
  },
  {
    id: 'M2',
    what: 'a missing observed_at is treated as age zero rather than "never read"',
    why: 'THE ISSUE ITSELF, inverted: the NEVER_READ channels become permanently ineligible, so the five tasks #598 was filed on are the only five never polled -- and NEVER_READ still reports them, forever. Killed by A1/A2.',
    find: '    const ageMs = Number.isNaN(t) ? Infinity : now - t;',
    replace: '    const ageMs = Number.isNaN(t) ? 0 : now - t;',
  },
  {
    id: 'M3',
    what: 'the ordering is reversed, so the freshest stale channel is served first',
    why: 'bounded plus wrongly-ordered is starvation with a healthy-looking throughput number: the pass reports "observed 15" every run while the oldest channel is never reached. Killed by A2/A3.',
    find: '    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;   // oldest / never-observed first',
    replace: '    if (a.ageMs !== b.ageMs) return a.ageMs - b.ageMs;   // oldest / never-observed first',
  },
  {
    id: 'M4',
    what: 'the per-pass cap is dropped',
    why: 'unbounded Google calls against a fleet of 81+ docs, which is the rate-limit failure #586 and #590 already cost this repo two fixes. Killed by A6.',
    find: '  return candidates.slice(0, Math.max(0, limit));',
    replace: '  return candidates;',
  },
  {
    id: 'M5',
    kind: 'absence',
    what: "an `unreadable` observation is accepted as a successful read",
    why: 'the exact conflation this channel exists to prevent: a transport failure would stamp observed_at, clear the staleness, and report the channel read and empty -- so an instruction Shiv believes was received is dropped, and the task looks healthy. #531 was this same conflation pointing the other way.',
    find: "      if (observation !== 'read') return { ok: false, reason: `observation: ${observation}` };",
  },
  {
    id: 'M6',
    what: 'the resolver drops the flat OA-home candidate and knows only the plugin layout',
    why: 'THE REGRESSION, exactly: run-sweeps.ps1 invokes the OA home copy, where ../skills/overnight-agent does not exist, so every observation dies on a missing file and the stale count never falls. It is success-shaped because the failure is per-task and looks like a Google outage. Killed by B1.',
    find: "    path.join(here, 'oa-state.ps1'),                                    // OA home (flat)\n",
    replace: '',
  },
  {
    id: 'M7',
    what: 'the resolver drops the plugin-tree candidate, keeping only the flat one',
    why: 'the same 100% failure moved to the other deploy target. A fix that trades one copy for the other is not a fix, and only an arm per layout catches it. Killed by B2.',
    find: "    path.join(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1'), // plugin tree\n",
    replace: '',
  },
  {
    id: 'M8',
    what: 'an unresolvable lookup returns a plausible path instead of null',
    why: 'the caller then spawns a non-existent script once per task, producing N identical errors that read as a transport failure rather than as one missing file -- which is precisely why this bug survived every run it broke. Killed by B3.',
    find: "  return candidates.find((c) => exists(c)) || null;",
    replace: "  return candidates.find((c) => exists(c)) || candidates[candidates.length - 1];",
  },
];

async function run() {
  console.log('mutcheck-observe-bound-docs (#598)');
  const original = readFileSync(SUBJECT, 'utf8');
  // The working tree may hold CRLF on Windows while CI checks out LF. Normalise the SOURCE to
  // whatever it actually uses by matching against LF and writing back in kind -- hardcoding
  // either makes an arm read as "the fix was deleted" on the other platform, which is a false
  // red that teaches people to ignore this check.
  const lf = original.replace(/\r\n/g, '\n');

  console.log('\nBASELINE');
  const baseFailures = await suite(SUBJECT);
  if (baseFailures > 0) {
    console.log(`\nBASELINE FAILED with ${baseFailures} failure(s) -- the fix is not in place.`);
    process.exit(1);
  }

  let survivors = 0;
  const mutantPath = join(HERE, '.mutant-observe-bound-docs.mjs');

  for (const m of MUTATIONS) {
    console.log(`\n${m.id}  ${m.what}`);
    console.log(`    why: ${m.why}`);

    if (m.kind === 'absence') {
      // Some defects are not expressible against the pure function because they live in the
      // effect path. For those the assertion is that the guarding line is still there at all.
      const present = lf.includes(m.find);
      if (present) console.log('    ok   guard present in source');
      else {
        survivors++;
        console.log(`    SURVIVED -- guard missing: ${m.find.trim()}`);
      }
      continue;
    }

    if (!lf.includes(m.find)) {
      survivors++;
      console.log(`    SURVIVED -- anchor not found, so this arm tested nothing: ${m.find.trim().slice(0, 70)}`);
      continue;
    }
    writeFileSync(mutantPath, lf.replace(m.find, m.replace), 'utf8');
    failures = 0;
    const got = await suite(mutantPath);
    if (got === 0) {
      survivors++;
      console.log('    SURVIVED -- the suite passed with this mutation in place.');
    } else {
      console.log(`    killed by ${got} assertion failure(s)`);
    }
    try { unlinkSync(mutantPath); } catch { /* best effort */ }
  }

  failures = 0;
  console.log('');
  if (survivors) {
    console.log(`${survivors} mutation(s) SURVIVED -- the guard does not hold.`);
    process.exit(1);
  }
  console.log(`all ${MUTATIONS.length} mutations killed.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
