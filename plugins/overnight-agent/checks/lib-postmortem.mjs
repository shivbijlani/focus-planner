// lib-postmortem.mjs — the recurrence detector behind Dream mode's postmortem reviewer
// (task #425, approved 2026-08-28 via #443's `approve 442 425 395, shrink 399`).
//
// WHAT THIS IS FOR
// -----------------------------------------------------------------------------
// #425 asks Dream mode to read COMPLETED-task postmortems, notice work that is
// likely to repeat, and turn it into a skill or a helper script — so the skill
// library stops being something Shiv curates by hand.
//
// The whole risk of that feature is over-firing. A detector that proposes a new
// skill after every completed task produces skill proliferation, which is worse
// than the manual curation it replaces: #357 already measured 14 skills, four of
// them linked into only one of the two harness pickup dirs, and one library copy
// 52 days stale and unlinked. Adding more, automatically, on weak evidence, is
// how that becomes unmanageable.
//
// So the detector is deliberately CONSERVATIVE and the gates are the feature.
// Each gate below is a separate exported predicate precisely so
// `mutcheck-postmortem.mjs` can delete exactly one and prove it breaks exactly
// its own negative case — the same discipline as lib-lost-interpolation.mjs and
// lib-external-artifacts.mjs.
//
// THE EVIDENCE RULE THAT MATTERS MOST
// -----------------------------------------------------------------------------
// A postmortem signal only counts when it comes from text SHIV wrote, or from a
// repetition observed across SEPARATE tasks. An agent-authored "this will recur"
// is the agent quoting itself, and must never create its own obligation. This is
// the same trap `recurring-liveness-sweep.mjs` records for cadence evidence, and
// the same one #227 fixed for consent: the agent writes the journal, so unmarked
// prose in it is not independent evidence about the agent's own work.
//
// AUTHORSHIP IS NOT MARKER-BASED (inherited from recurring-liveness-sweep)
// -----------------------------------------------------------------------------
// The app appends many of Shiv's messages as a bare `## <date>` header with no
// `<!-- from: me -->` marker at all. Keying authorship off the marker alone
// missed the founding case of #236. So: a `## <date>` section belongs to Shiv
// until an agent marker or an agent-shaped heading starts the reply.

const rxSentinel = /^<!--\s*OVERNIGHT-AGENT/m;
const rxFromMe = /^<!--\s*from:\s*me\s*-->/i;
const rxFromAgent = /^<!--\s*from:\s*overnight-agent\s*-->/i;
const rxDateHeader = /^##\s+(\d{4}-\d{2}-\d{2})/;
const rxAgentHeading = /^#{2,4}\s+(Run log|🌙\s*Overnight Agent)/i;
const rxTurnEnd = /^<!--\s*\/overnight-agent\s+turn-end\s*-->/i;

/**
 * Split a journal into authored segments.
 *
 * Returns [{ author: 'me' | 'agent', text }]. Authorship follows the
 * recurring-liveness rule above rather than the marker alone, because the
 * marker is absent on a large share of Shiv's real messages.
 */
export function segmentByAuthor(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  // Everything above the managed sentinel is Shiv's space by definition (SKILL.md:
  // "Never edit anything above the sentinel"). Below it, authorship alternates.
  let author = 'me';
  let buf = [];
  const flush = () => {
    if (buf.length) out.push({ author, text: buf.join('\n') });
    buf = [];
  };
  for (const line of lines) {
    if (rxSentinel.test(line)) {
      flush();
      author = 'agent';
      continue;
    }
    if (rxFromMe.test(line)) {
      flush();
      author = 'me';
      continue;
    }
    if (rxFromAgent.test(line) || rxAgentHeading.test(line) || rxTurnEnd.test(line)) {
      flush();
      author = 'agent';
      continue;
    }
    if (rxDateHeader.test(line)) {
      // A new dated section reverts to Shiv until an agent marker/heading claims it.
      flush();
      author = 'me';
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.filter((s) => s.text.trim().length > 0);
}

/** Text Shiv wrote, concatenated. The only self-standing evidence source. */
export function humanText(text) {
  return segmentByAuthor(text)
    .filter((s) => s.author === 'me')
    .map((s) => s.text)
    .join('\n');
}

// -----------------------------------------------------------------------------
// The signal vocabulary — step 1 of the approved plan: the postmortem input
// contract. A postmortem "signal" is one of three things, and nothing else:
//
//   correction  — Shiv told the agent it did the thing wrong / do it this way
//   blocker     — the same obstacle stopped the work
//   procedure   — a repeatable multi-step recipe the agent had to work out
//
// Each is matched only inside human-authored text (correction, blocker) or from
// cross-task repetition (procedure), never from the agent's own narration.
// -----------------------------------------------------------------------------

const CORRECTION_PHRASES = [
  /\bno[,.]? (?:not|don'?t|do not)\b/i,
  /\b(?:don'?t|do not|never) (?:do|use|write|send|add|open|create|ask)\b/i,
  /\b(?:next time|from now on|going forward|in future|always)\b/i,
  /\b(?:that'?s|thats|this is) (?:wrong|not right|not what)\b/i,
  /\b(?:actually|instead)[, ] (?:use|do|make|write)\b/i,
  /\bstop (?:asking|doing|adding|sending)\b/i,
];

const BLOCKER_PHRASES = [
  /\b(?:blocked|blocker|stuck|can'?t proceed|cannot proceed)\b/i,
  /\b(?:keeps?|kept) (?:failing|breaking|happening)\b/i,
  /\b(?:again|still) (?:broken|failing|not working)\b/i,
  /\bhaving to (?:restart|redo|repeat)\b/i,
];

// A procedure is a numbered/step-shaped recipe. Counted structurally, not by
// keyword, because the point is "this was worked out and will be needed again".
const rxStepLine = /^\s*(?:\d+[.)]|[-*]\s+\*\*Step)\s+\S/;

/**
 * Extract postmortem signals from one completed task's journal.
 *
 * @param {string} text  full journal contents
 * @returns {{kind:string, evidence:string, author:string}[]}
 */
export function extractSignals(text) {
  const signals = [];
  const human = humanText(text);

  for (const line of human.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (CORRECTION_PHRASES.some((rx) => rx.test(trimmed))) {
      signals.push({ kind: 'correction', evidence: trimmed.slice(0, 160), author: 'me' });
      continue;
    }
    if (BLOCKER_PHRASES.some((rx) => rx.test(trimmed))) {
      signals.push({ kind: 'blocker', evidence: trimmed.slice(0, 160), author: 'me' });
    }
  }

  // Procedure evidence is structural and may come from the agent's own run log —
  // it is a description of work performed, not a claim that it will recur. The
  // recurrence gate below is what decides whether it matters.
  //
  // The evidence string carries the STEP TEXT, not just a count, because signals
  // are attached to topics by containment (see `review`). A signal whose evidence
  // is "7 step-shaped lines" mentions no topic and so could never attach to one —
  // the first cut did exactly that and the procedure half of route B was dead.
  const stepLines = text.split(/\r?\n/).filter((l) => rxStepLine.test(l));
  if (stepLines.length >= 3) {
    signals.push({
      kind: 'procedure',
      evidence: stepLines.join(' ').slice(0, 400),
      author: 'agent',
    });
  }

  return signals;
}

// -----------------------------------------------------------------------------
// Topic extraction — how two tasks are judged to be "the same kind of work".
//
// Deliberately crude and rare-word based, matching the entity-rarity gate that
// external-artifact-sweep proved necessary: a token appearing in most journals
// is ambient vocabulary, not an identifying fact.
// -----------------------------------------------------------------------------

const STOP = new Set(
  ('the a an and or but if then this that these those with without from into onto for to of in on at by as is are was were be been being it its it\'s i you he she we they me him her us them my your his our their not no yes do does did done doing have has had having will would can could should may might must shall about after again all also am any because before below between both during each few further here how more most other over own same some such than too under until up very what when where which while who whom why can\'t don\'t task agent run journal plan status overnight')
    .split(/\s+/),
);

export function topicTokens(text, title = '') {
  const src = `${title}\n${text}`.toLowerCase();
  const words = src.match(/[a-z][a-z0-9-]{3,}/g) || [];
  const counts = new Map();
  for (const w of words) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

/**
 * GATE 1 — RECURRENCE.
 *
 * The approved plan (step 2): "requires multiple matching tasks OR one explicit
 * user correction plus a clear reusable pattern; score confidence and suppress
 * one-off chores."
 *
 * So a candidate qualifies on either of exactly two routes, and nothing else:
 *   route A — the same topic appears in >= MIN_TASKS separate completed tasks
 *             AND at least one postmortem signal is ATTACHED to that topic
 *   route B — one explicit human CORRECTION *and* a procedure, both attached
 *
 * Route B requires both halves. A correction with no reusable pattern is
 * feedback about one task; a procedure with no correction is just work that got
 * done. Neither alone is a reason to mutate the skill library.
 *
 * ⚠️ THE ATTACHED-SIGNAL CLAUSE ON ROUTE A IS NOT DECORATION — IT WAS MEASURED.
 * Without it, route A reduces to "a word occurs in two journals", and the first
 * run of this detector against the live corpus (52 completed tasks) accepted
 * **1,417 candidates**, proposing `extract-script -> there.mjs`, `still.mjs`,
 * `real.mjs` and `line.mjs`. That is the exact proliferation failure #357 warns
 * about, arriving automatically. A repeated topic with no postmortem signal
 * behind it is vocabulary, not a lesson.
 */
export const MIN_TASKS = 2;

export function passesRecurrence(candidate) {
  // Only signals Shiv authored can carry route A. A `procedure` signal is the
  // agent describing work it performed; letting that satisfy "there is evidence
  // here" is the agent vouching for itself, which is the #227 mistake in a new
  // place. Measured: allowing it left 195 candidates including `ever.mjs`,
  // `says.mjs` and `half.mjs` — words that merely fell inside 400 characters of
  // quoted step text.
  const humanTasks = new Set(
    candidate.signals.filter((s) => s.author === 'me' && s.taskId).map((s) => s.taskId),
  );
  const routeA = candidate.taskIds.length >= MIN_TASKS && humanTasks.size >= MIN_TASKS;
  const routeB =
    candidate.signals.some((s) => s.kind === 'correction' && s.author === 'me') &&
    candidate.signals.some((s) => s.kind === 'procedure');
  return routeA || routeB;
}

/**
 * GATE 2 — ONE-OFF CHORE SUPPRESSION.
 *
 * "suppress one-off chores" (approved plan, step 2). A chore is work whose
 * value is entirely in the doing — book a table, buy a gift, send one email.
 * Encoding it as a skill produces a skill that will never fire again.
 *
 * Keyed on the topic word, not on the task text, so a task that merely mentions
 * a purchase while building a tool is not suppressed.
 */
const CHORE_TOPICS = new Set([
  'buy', 'bought', 'purchase', 'order', 'ordered', 'gift', 'birthday',
  'book', 'booked', 'booking', 'reservation', 'flight', 'hotel', 'ticket',
  'appointment', 'renew', 'cancel', 'refund', 'return', 'rsvp', 'invite',
]);

export function isOneOffChore(candidate) {
  return CHORE_TOPICS.has(candidate.topic);
}

/**
 * GATE 3 — PRIVACY.
 *
 * "Never infer credentials or copy private task data into shareable skill
 * files" (approved plan, step 4). A skill file is shareable by construction —
 * SKILL.md is explicitly the file kept clean so it can be shared, with personal
 * data pushed out to user-settings.md. So anything carrying a secret or a
 * personal identifier must never become skill text.
 *
 * This gate SUPPRESSES the candidate rather than redacting it. Redaction is a
 * guess; suppression is safe, and the reviewer prints that it happened so the
 * decision is visible rather than silent.
 */
const SECRET_PATTERNS = [
  /\b(?:password|passwd|secret|api[_-]?key|token|bearer|credential)\b\s*[:=]/i,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/,
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr)\b/,
];

export function containsPrivateData(text) {
  return SECRET_PATTERNS.some((rx) => rx.test(text));
}

/**
 * GATE 4 — EXISTING-SKILL PREFERENCE.
 *
 * "Prefer reuse and small patches over skill proliferation" (approved plan,
 * step 3). If a skill already covers the topic, the routed action must be
 * `refine-skill`, never `new-skill`. Without this the detector's default
 * outcome is a new skill every time, which is the proliferation failure #357
 * warned about.
 */
export function routeAction(candidate, existingSkills) {
  const topic = candidate.topic;
  const hit = existingSkills.find(
    (s) => s.toLowerCase().includes(topic) || topic.includes(s.toLowerCase()),
  );
  if (hit) return { action: 'refine-skill', target: hit };
  // A procedure with many deterministic steps is better as a script than prose.
  if (candidate.signals.some((s) => s.kind === 'procedure') && candidate.taskIds.length >= MIN_TASKS) {
    return { action: 'extract-script', target: `${topic}.mjs` };
  }
  return { action: 'new-skill', target: topic };
}

/**
 * Confidence score, 0..1. Reported so a human can triage, never used as the
 * sole gate — the gates above are boolean and must all pass.
 */
export function scoreConfidence(candidate) {
  let score = 0;
  score += Math.min(candidate.taskIds.length, 4) * 0.15;
  if (candidate.signals.some((s) => s.kind === 'correction' && s.author === 'me')) score += 0.3;
  if (candidate.signals.some((s) => s.kind === 'blocker')) score += 0.1;
  if (candidate.signals.some((s) => s.kind === 'procedure')) score += 0.15;
  return Math.min(1, Number(score.toFixed(2)));
}

/**
 * GATE 5 — ENTITY RARITY (ambient vocabulary).
 *
 * Borrowed verbatim from `external-artifact-sweep`, which already established
 * on this corpus that "an entity in >4 journals is ambient vocabulary, not an
 * identifying fact". The first cut here used a RELATIVE limit (half the corpus),
 * which on 52 completed tasks allowed a word in 26 journals to count as a topic
 * — that is how `there`, `still` and `real` became proposed helper scripts.
 *
 * An absolute cap is the right shape because "rare" is a property of the word,
 * not of how many tasks happen to be finished this month.
 */
export const AMBIENT_MAX_DOCS = 4;

/**
 * The full pipeline over a set of completed tasks.
 *
 * @param {{id:string, title:string, text:string}[]} tasks completed tasks only
 * @param {string[]} existingSkills names of skills already installed
 * @returns {{accepted:object[], rejected:object[]}}
 */
export function review(tasks, existingSkills = []) {
  const perTopic = new Map();
  const docFreq = new Map();

  for (const t of tasks) {
    const counts = topicTokens(t.text, t.title);
    const signals = extractSignals(t.text);
    const seen = new Set();
    for (const [word, n] of counts) {
      if (n < 3) continue; // must be substantive within its own task
      seen.add(word);
      if (!perTopic.has(word)) perTopic.set(word, { topic: word, taskIds: [], signals: [] });
      const c = perTopic.get(word);
      c.taskIds.push(t.id);

      // ⚠️ SIGNAL ATTACHMENT — a signal belongs to a topic only when the topic
      // word actually appears in that signal's own evidence. The first cut
      // attached EVERY signal in a task to EVERY topic in that task, so one
      // human correction about resumes marked all ~40 words in that journal as
      // carrying a correction. Combined with the relative rarity limit above,
      // that produced 1,417 accepted candidates on the live corpus.
      //
      // Containment is deliberately crude but it is evidence-preserving: the
      // reviewer prints the matched line, so a human rejects a bad attachment by
      // reading it rather than by trusting a score.
      for (const s of signals) {
        if (s.evidence.toLowerCase().includes(word)) c.signals.push({ ...s, taskId: t.id });
      }
    }
    for (const w of seen) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  }

  const accepted = [];
  const rejected = [];

  for (const c of perTopic.values()) {
    c.taskIds = [...new Set(c.taskIds)];
    const reject = (reason) => rejected.push({ ...c, reason });

    if ((docFreq.get(c.topic) || 0) > AMBIENT_MAX_DOCS) { reject('ambient-vocabulary'); continue; }
    if (isOneOffChore(c)) { reject('one-off-chore'); continue; }
    if (!passesRecurrence(c)) { reject('insufficient-recurrence'); continue; }

    const evidence = c.signals.map((s) => s.evidence).join('\n');
    if (containsPrivateData(evidence)) { reject('private-data'); continue; }

    const routed = routeAction(c, existingSkills);
    accepted.push({ ...c, ...routed, confidence: scoreConfidence(c) });
  }

  accepted.sort((a, b) => b.confidence - a.confidence);
  return { accepted, rejected };
}
