// lib-unsupervised.mjs — write-path defects in agent-written markdown that lives
// OUTSIDE `<planner>\journal`, where no nightly check has ever looked.
//
// Established 2026-08-26 08:35 PT, closing a blind spot the 08:00 run named but
// did not fix:
//
//     "Rule: agent-written markdown outside the journal folder gets no nightly
//      check at all. When a deliverable lands in a project folder, it is
//      unsupervised."
//
// That run proved the gap was not theoretical by re-running the interpolation
// matcher by hand over ~835 files and finding two victims the registered sweep
// structurally could not see:
//   1. `user-settings.md` ITSELF — the file that records the rules — had lost the
//      entire #249 result and every figure in a cautionary bullet about prices.
//   2. `Career\Resume\Resume-Building-ChatGPT-for-Work.md` — 116 KB on ONE line, a
//      raw JSON string written verbatim instead of decoded, carrying 2,354 literal
//      `\n` sequences. 158 messages of career material, unreadable as markdown.
//
// A hand re-run is not a check. This module is the second defect's matcher; the
// first is reused verbatim from `lib-lost-interpolation.mjs`, per the standing rule
// that a checker must drive the producer's own matching semantics.
//
// WHY A SEPARATE ARM RATHER THAN A REGEX IN THE SWEEP
// -----------------------------------------------------------------------------
// So `mutcheck-unsupervised.mjs` can drive this exact code, and so the guards are
// individually mutation-killable. Same discipline as the interpolation lib.

// A JSON payload that was stringified and then written straight to disk keeps its
// ESCAPE sequences as two literal characters — backslash then `n` — instead of the
// newline it stands for. That is the whole tell: a markdown file that contains many
// literal `\n` on a single enormous line is not markdown, it is a JSON string.
const MIN_LINE_LEN = 1000; // a real markdown line is never this long
const MIN_ESCAPES = 20; // 2,354 in the live specimen; 20 is far below it

// The payload must actually open like JSON. Without this guard a long minified
// HTML line (legitimate) matches on `\n` count alone.
const JSON_OPENER = /^[[{]?\s*"/;

/**
 * Detect a file whose markdown is really an undecoded JSON string.
 *
 * @param {string} text full file contents
 * @returns {{n:number, line:string, strong:boolean, kind:string, escapes:number}[]}
 */
export function findUndecodedJson(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < MIN_LINE_LEN) continue;

    // Count LITERAL backslash-n pairs, not newlines. `\\n` (an escaped backslash
    // followed by n) is not an escape sequence, so step over it rather than
    // counting it — otherwise a document ABOUT escaping scores as damaged.
    let escapes = 0;
    for (let j = 0; j < line.length - 1; j++) {
      if (line[j] !== '\\') continue;
      if (line[j + 1] === '\\') { j++; continue; }
      if (line[j + 1] === 'n') escapes++;
    }
    if (escapes < MIN_ESCAPES) continue;

    if (!JSON_OPENER.test(line.trimStart())) continue;

    out.push({
      n: i + 1,
      line: line.slice(0, 120),
      strong: true,
      kind: 'undecoded-json',
      escapes,
    });
  }
  return out;
}

/** Roots that hold agent-written markdown but are NOT covered by any other sweep.
 *  `<planner>\journal` is deliberately absent: `lost-interpolation-sweep` owns it,
 *  and double-reporting the same 14 known files would drown the new signal. */
export function unsupervisedRoots(env = process.env) {
  const oneDrive = env.OneDrive || 'C:\\Users\\shiv\\OneDrive';
  return [
    `${oneDrive}\\Documents (Private)`,
    `${oneDrive}\\Apps\\Focus Planner`,
    `${oneDrive}\\utilities-analysis`,
    `${oneDrive}\\overnight-agent`,
  ];
}
