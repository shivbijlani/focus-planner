// lib-lost-interpolation.mjs — detect text where a value was SILENTLY DELETED by
// shell interpolation before it was ever written to disk.
//
// Exported so the sweep and its mutation check drive the SAME code (the standing
// rule: a checker must use the producer's own matching semantics, or it invents
// bugs that aren't there — cf. the #267 false positive).
//
// THE MECHANISM
// -----------------------------------------------------------------------------
// A run that writes markdown through a PowerShell DOUBLE-QUOTED string has every
// `$token` expanded. `$150` is not a defined variable, so PowerShell expands it to
// the EMPTY STRING and the write succeeds. No error, no warning; the number is
// simply gone and the file still looks well-formed.
//
// It is legible only because agents correctly markdown-escape a literal dollar sign
// as `\$`. The backslash is not a variable reference, so it survives as a tombstone
// while the amount evaporates:
//
//     intended : "~\$150–275"      ->  on disk : "~\–275"
//     intended : "\$12.92"         ->  on disk : "\.92"     (cents survive!)
//     intended : "**~\$2,035**"    ->  on disk : "**~\,035**"
//
// THE FALSE-POSITIVE TRAP
// -----------------------------------------------------------------------------
// Journals are full of legitimate backslashes and the naive matchers all fail:
//   /\\\d{2,}/          flags Windows paths  ...\GitHub-2026-06-20\...
//   /\\(?=[)\s])/       flags a path that ends in a separator: `(Focus Planner\journal\)`
//   /\\(?=\*)/          flags a glob escape `github.com/shivbijlani/\*`
//                       and a footnote marker `\*Ranges are typical market rates`
//   /\*\*\\/            flags escaped angle brackets `**\<name\>**`
// Each of those was a real false positive in an earlier cut of this check.
//
// TWO DISCRIMINATORS DO ALL THE WORK:
//   1. WHAT PRECEDES IT. A path separator is always preceded by a word character,
//      `.`, `:` or `…`. An eaten value never is — it is preceded by whitespace,
//      `~`, `(`, `*`, a dash, or a table pipe.
//   2. WHAT FOLLOWS IT. A markdown escape is `\` + the punctuation being escaped
//      (`\$ \< \> \[ \_ \# \+ \- \!`), so the follower is meaningful. An eaten value
//      leaves the backslash followed by whitespace, a sentence delimiter, a closing
//      bracket, a range dash, orphaned cents, or end-of-line.

// A backslash that is part of a Windows path is preceded by one of these.
const PATH_LEFT = /[\w.:…]/;
// Left-hand contexts where a `\$<amount>` demonstrably used to sit.
const PRICE_LEFT = /[~(*]/;
// Escapes that are ALWAYS an escape, in any context: the character after the
// backslash is structural markdown that genuinely needs escaping.
// `$` is deliberately NOT here — it is handled by its own guard below, because
// "the dollar survived" is the single most important signal this matcher has and
// it should be visible (and independently mutation-killable) on its own line.
const STRUCT_ESCAPE = /[<>[_#+!&{}'"`\\|^=]/;
// Escapes that are only an escape OUTSIDE price context. A literal `\)` or `\-` is
// plausible prose, but after a tilde or an opening paren it is a tombstone:
// `(~\$50)` eats to `(~\)`, and that must not be swallowed by the escape guard.
const CLOSER_ESCAPE = /[)\]}\-]/;
// What is left over when the payload was eaten.
// NOTE `/` is here, not in the escape sets: `\/` is not a markdown escape, and it
// is a real tombstone shape — `~\$40/yr` eats to `~\/yr` (#249).
const EATEN_RIGHT = /[\s.,;:)\]}%/]|[–—]/;

/** Is the whitespace-delimited token containing `i` demonstrably a filesystem path?
 *
 * `PATH_LEFT` only inspects ONE character to the left, which is enough for
 * `Applications\GitHub` but blind to a separator that follows a non-word
 * character. Live false positive (#296): `.github\skills\<name>\ with a SKILL.md`
 * — the final separator is preceded by `>`, so the one-char test failed and a
 * path was reported as an eaten value.
 *
 * The reliable signal is the token as a whole: if ANY backslash in it is
 * preceded by a word character, the token is a path and every separator in it
 * is structural. An eaten `\$amount` never shares a token with a real path
 * separator — `~\–275`, `\.92` and `\**` each contain exactly one backslash,
 * preceded by `~`, a space or a delimiter.
 */
function inPathToken(line, i) {
  let s = i;
  while (s > 0 && !/\s/.test(line[s - 1])) s--;
  let e = i;
  while (e < line.length - 1 && !/\s/.test(line[e + 1])) e++;
  let sep = 0;
  for (let k = s; k <= e; k++) {
    if (line[k] === '\\' && k > s && PATH_LEFT.test(line[k - 1])) sep++;
  }
  // TWO word-preceded separators, not one. A single one is not enough: #326
  // carries `(\job-post.md\ + \rubric-score.md\ ...)`, where backtick code-span
  // delimiters were rewritten to backslashes by the same write-path defect. Its
  // trailing `d\` is word-preceded, so a >=1 test absolved it and silently
  // dropped a true positive — measured, not assumed. Every real path token in
  // the live corpus has at least two (`.github\skills\<name>\`,
  // `accident\\draft-emails\\.`), because a path needs a parent and a child.
  return sep >= 2;
}

/**
 * @param {string} line one line of markdown, code spans already stripped
 * @returns {{index:number, strong:boolean}[]}
 */
export function findTombstones(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '\\') continue;
    const left = i > 0 ? line[i - 1] : '';
    const right = i + 1 < line.length ? line[i + 1] : '';

    // 1. Windows path separator -> never a tombstone.
    if (left && PATH_LEFT.test(left)) continue;

    // 1a. A separator anywhere inside a path-shaped token.
    //     `PATH_LEFT` inspects only ONE character to the left, which is blind to
    //     a separator that follows a non-word character. Three live shapes were
    //     leaking, all on board-active tasks:
    //       #296  `.github\skills\<name>\ with a SKILL.md`  — separator after `>`
    //       #276  `OneDrive\\...\\Applications\\GitHub-...` — JSON-doubled path
    //       #289  `accident\\draft-emails\\.`                — JSON path, then `.`
    //     In every case some backslash in the token IS word-preceded, which is
    //     an unambiguous path signal. An eaten `\$amount` never shares a token
    //     with a real separator: `~\–275`, `\.92` and `\**` each hold exactly
    //     one backslash, preceded by `~`, a space or a delimiter.
    //
    //     A narrower `left === '\\'` guard for the JSON-doubled cases was tried
    //     and REMOVED: mutcheck-li-guards.mjs proved it unexercised, because
    //     this token test already covers them.
    if (inPathToken(line, i)) continue;

    // 2. The `$` survived -> the amount survived. This is the CORRECT shape.
    if (right === '$') continue;

    // 3. Structural escape -> a real escape in any context.
    //    (`**\<name\>**` in #263 is the live example.)
    if (right && STRUCT_ESCAPE.test(right)) continue;

    const priced = PRICE_LEFT.test(left);

    // 4. `\*` is ambiguous: a legitimate glob escape after `/`, a legitimate
    //    footnote marker at the start of a line, an escaped literal asterisk in
    //    quoted prose — but a tombstone when a `\$amount` was eaten from inside
    //    bold (`**Turo NV3500HD \**`, #412).
    //
    //    The discriminator is what follows the asterisk. `\**` is bold CLOSING
    //    on an empty payload, which is the eaten-value shape. `\*` + a word
    //    character is someone escaping a literal asterisk — live false positive
    //    (#348): quoting Shiv verbatim as `*"\*Sections"*`.
    if (right === '*') {
      if (i === 0 || left === '/' || left === '') continue;
      const after = line[i + 2] || '';
      if (after !== '*' && !priced) continue;
      out.push({ index: i, strong: priced });
      continue;
    }

    // 5. A closing/dash escape is a real escape only outside price context.
    //    ⚠️ UNEXERCISED as of 2026-08-26: removing this guard changes neither the
    //    mutation corpus nor the live 356-file corpus (16 files / 60 lines either
    //    way). It is kept because `(~\$50)` -> `(~\)` is a shape the eaten-value
    //    mechanism can obviously produce, but it is DEFENSIVE, not verified — do
    //    not cite it as tested. If a real `\)` tombstone ever shows up, harvest it
    //    into the mutcheck and this guard becomes load-bearing.
    //
    //    EXCEPTION, added 2026-08-26 11:20: `\-` immediately followed by a DIGIT
    //    is the low end of a price range being eaten — `$515-520` -> `\-520`.
    //    Found while recovering #412 from its deliverable: the journal read
    //    "max Enterprise/Alamo Odyssey \-520", the surviving deliverable read
    //    "$515" / "$520", and the matcher had silently missed it because the
    //    backslash sits after a space rather than a `~`. A literal escaped dash
    //    in prose ("\- this is a literal dash") is followed by a space or a
    //    letter, never a digit, so the digit is the whole discriminator.
    const rangeLowEaten = right === '-' && /\d/.test(line[i + 2] || '');
    if (right && CLOSER_ESCAPE.test(right) && !priced && !rangeLowEaten) continue;

    // 6. Payload eaten: whitespace / delimiter / dash / EOL after the backslash.
    if (right === '' || EATEN_RIGHT.test(right) || priced || rangeLowEaten) {
      const strong =
        priced ||
        rangeLowEaten ||
        /[–—]/.test(right) ||
        (/[.,]/.test(right) && /\d/.test(line[i + 2] || ''));
      out.push({ index: i, strong });
    }
  }
  return out;
}

/** Strip inline code spans: code legitimately contains backslashes.
 *
 * ⚠️ KNOWN BLIND SPOT (measured 2026-08-26). The same `$`-interpolation defect
 * damages text INSIDE code spans too — #249 carried `` `.1338/kWh` `` where
 * `` `$0.1338/kWh` `` was intended, and three more on the same two lines. But
 * code spans do not use markdown escaping, so there is no `\` tombstone: the
 * deletion is perfectly silent and this matcher structurally cannot see it.
 *
 * The one candidate signature — a code span opening with `.` + digits — was
 * measured against the live corpus and REJECTED: 5 hits in 2 files, all of them
 * the legitimate `` `.600` `` drip-tubing marking in #422, and 0 true positives.
 * Shipping it would have been a pure false-positive generator.
 *
 * So the honest scope of this sweep is: it catches the damage wherever the `\$`
 * convention was used, which is prose — the large majority — and misses it in
 * code spans. Recover those the way #249 was recovered: from the task's own
 * DELIVERABLE file, which is written by a different code path and survives intact.
 */
export function stripCode(line) {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

export function scanText(text) {
  // ARM 3 — the backtick-escape twin, detected on the RAW text before line
  // splitting, because the damage IS a stray control character.
  //
  // PowerShell's escape character is the BACKTICK, and markdown's inline-code
  // delimiter is also the backtick. So writing markdown through a PowerShell
  // double-quoted string silently rewrites every code span whose content starts
  // with r/n/t/a/b/f/v/0:
  //     `renderInline`   -> CR  + "enderInline"
  //     `task-192-...md` -> TAB + "ask-192-...md"
  // and drops the delimiters entirely for every other code span (`` `x` `` -> x),
  // because a backtick before an ordinary character just yields that character.
  //
  // A lone CR (one not part of a CRLF pair) is an exact, zero-false-positive
  // signature for the `r` case: no legitimate writer emits a bare CR mid-file.
  // Found live 2026-08-26 in #313 (`renderInline`), #399 x4 (`reopened`,
  // `reference.md`) and #326 (`rubric-score.md`).
  const loneCr = [];
  {
    const re = /\r(?!\n)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const upto = text.slice(0, m.index);
      loneCr.push({
        n: upto.split(/\r\n|\n/).length,
        line: text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\r(?!\n)/g, '<CR>').replace(/\n/g, ' '),
        strong: true,
        kind: 'backtick-escape-cr',
      });
    }
  }

  const lines = text.split(/\r?\n/);
  const hits = [...loneCr];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // ARM 2 — the same backtick-escape defect landing as a TAB rather than a CR.
    // The link target survives (it is written separately), so the damage is silent:
    // the label reads `⇥ask-192-roadmap.md`. Found live in #192, #213, #370.
    const tabDamage = /\t(?:ask|odo|est|arget|ally)-|\[\t|\|\s*\t\S/.test(raw);
    if (tabDamage) {
      hits.push({ n: i + 1, line: raw.replace(/\t/g, '<TAB>').trim(), strong: true, kind: 'backtick-escape-tab' });
      continue;
    }

    // ARM 4 — an eaten value inside BOLD, which leaves NO backslash tombstone.
    //
    // The `\$` convention is what makes this defect legible, but an agent writing
    // a price into a table cell often bolds it WITHOUT escaping: `**$471**` and
    // `~**$1,035**`. PowerShell eats `$471` and `$1` respectively, leaving:
    //
    //     | **12** | **** ✅ |            (payload gone entirely)
    //     | 16 | ~**,035** (2×$515-520) | (the thousands separator survived)
    //
    // Both were sitting in #412's deliverable, invisible to every arm above,
    // while the SAME line's `\$` forms were caught — i.e. the sweep was reporting
    // one corrupted line in that file and missing two others beside it.
    //
    // Neither shape occurs in legitimate prose: an empty bold span says nothing,
    // and a bold span opening on a COMMA plus digits is a number missing its
    // leading digits. A row of asterisks used as a thematic break is excluded.
    //
    // ⚠️ Comma only, never `.`+digits. The decimal form was measured against the
    // live corpus and REJECTED for the same reason the code-span variant was:
    // its only hits are #422's legitimate `**.600-inch OD mainline**` drip-tubing
    // gauge. A comma cannot open a number in prose, so it carries no such twin.
    // Both shapes are matched against the CODE-STRIPPED line, exactly as arm 1
    // is. Without that, this arm fires on any text that *documents* the defect:
    // the run learnings and journal turns explaining it necessarily quote
    // `` `~**,035**` `` and `` `****` `` as examples, and a detector that flags
    // its own postmortem is a detector that gets switched off. Real damage sits
    // in prose and table cells, never inside backticks.
    const bare = stripCode(raw);
    const emptyBold = /(^|[\s|(])\*\*\*\*([\s|)]|$)/.test(bare) && !/^[\s*_-]+$/.test(bare);
    const severedNumber = /\*\*\s*,\d/.test(bare);
    if (emptyBold || severedNumber) {
      hits.push({
        n: i + 1,
        line: raw.trim(),
        strong: true,
        kind: emptyBold ? 'eaten-value-empty-bold' : 'eaten-value-severed-number',
      });
      continue;
    }

    const found = findTombstones(stripCode(raw));
    if (found.length) {
      hits.push({ n: i + 1, line: raw.trim(), strong: found.some((f) => f.strong), count: found.length, kind: 'eaten-value' });
    }
  }
  hits.sort((a, b) => a.n - b.n);
  return hits;
}
