// mutation check for undelivered-plan-sweep.mjs's irreversible-verb matcher (2026-08-26).
//
// WHY THIS CHECK EXISTS
// ---------------------
// The sweep's whole job is to notice a `proposed` plan whose body is entirely REVERSIBLE
// and which therefore should already have been executed-as-draft (SKILL.md PHASE 2 step 4).
// Everything hinges on one predicate: "does this plan body contain an irreversible action?"
//
// The first cut answered that with a flat token list — `\b(send|…|post|email|schedule|apply)\b`
// — and it was wrong in the most expensive possible direction. It dropped the FOUR
// joint-oldest tasks on the board, each on a noun:
//     #175 (73d)  "Draft a ready-to-post Facebook Marketplace listing"  -> "post"
//     #179 (73d)  "whether an Outlook/email MCP could automate …"       -> "email"
//     #213 (73d)  "materials list, and a weekend schedule"              -> "schedule"
//     #263 (72d)  "a one-page 'where it applies' list"                  -> "applies"
// A false NEGATIVE here is not neutral: it makes the longest-waiting tasks invisible to the
// one sweep built to find them, which is exactly how they reached 70+ days.
//
// The opposite error is worse still. A false POSITIVE tells an unattended run "this plan is
// safe to just do", so `buy`/`merge`/`send` must never be softened into a qualified form
// that a real plan can slip past. Hence the two tiers, and hence both corpora below:
//   POS  — plan bodies that genuinely contain an irreversible action (must MATCH).
//   NEG  — the four historical nouns plus reversible plan prose (must NOT match).
//
// Per the 2026-08-26 04:30 rule ("negative corpora are harvested from real UNSOLVED asks,
// so re-read the existing negatives when you add an arm"), the NEG list is seeded from the
// live journals verbatim rather than invented.

const IRREVERSIBLE_STRICT = /\b(send|sends|sending|submit|submits|submitting|buy|buys|buying|purchase|purchases|purchasing|merge|merges|merging|deploy|deploys|deploying|publish|publishes|publishing|pay|pays|paying|check\s*out|checkout|sign\s+up)\b/i;

const IRREVERSIBLE_QUALIFIED = [
  /(?<![-\w])post(?:s|ing)?\s+(?:it|them|this|the|a|an|to)\b/i,
  /(?<![-\w/])email(?:s|ing)?\s+(?:it|them|him|her|us|out\b|the\s|a\s|\S+@)/i,
  /\bschedul(?:e|es|ing)\s+(?:it|them|the|a|an)\b/i,
  /\bapply(?:ing)?\s+(?:for|to)\b/i,
  /\binstall(?:s|ing)?\s+(?:it|them|the|a|an)\b/i,
  /\bbook(?:s|ing)?\s+(?:it|them|the|a|an)\b/i,
  /\border(?:s|ing)?\s+(?:it|them|the|a|an|\d)\b/i,
  /\bplace\s+(?:the|an)\s+order\b/i,
  /\bdelet(?:e|es|ing)\s+(?:it|them|the|a|an)\b/i,
  /\bcancel(?:s|ling|ing)?\s+(?:it|them|the|a|an)\b/i,
];

const NEGATED = new RegExp(
  String.raw`\b(?:no|not|never|without|rather\s+than|instead\s+of|stopping\s+short\s+of)\s+` +
  String.raw`(?:\w+\s+){0,2}` +
  String.raw`(?:send|sent|sending|submit|submitting|buy|buying|purchase|purchasing|order|ordering|` +
  String.raw`merge|merging|deploy|deploying|book|booking|publish|publishing|pay|paying|post|posting|` +
  String.raw`email|emailing|install|installing|apply|applying|delete|deleting|cancel|cancelling|schedule|scheduling)\w*`,
  'gi',
);
const DRAFT_ONLY = /\bdraft\s+only\b/gi;
const strip = (s) => s.replace(NEGATED, ' ').replace(DRAFT_ONLY, ' ');

function matchIrreversible(s) {
  const m = s.match(IRREVERSIBLE_STRICT);
  if (m) return m[0];
  for (const re of IRREVERSIBLE_QUALIFIED) {
    const q = s.match(re);
    if (q) return q[0];
  }
  return null;
}
const hit = (s) => matchIrreversible(strip(s)) !== null;

// MUST MATCH — a plan containing any of these is legitimately gated behind approval.
const POS = [
  // Live drops, verbatim from the backlog on 2026-08-26.
  'Prep the purchase of the replacement over-the-range microwave and stage the order.',
  'Merge PR #63 once CI is green.',
  'Take the cart to checkout and complete the order.',
  'Purchase the two intercoms once the model is confirmed.',
  'Send the two dental record-request emails, cc Jody.',
  'The agent sends the finished packet to the claims adjuster.',
  'Buy the replacement seal kit from the OEM parts site.',
  'Delete the 55 stale Vacation rows once verified.',
  // Qualified forms must still fire when a real object follows.
  'Post it to Facebook Marketplace with the photos.',
  'Email him the draft once it reads well.',
  'Email sneha@bijlanis.com with the final list.',
  'Schedule the appointment with the dentist for next week.',
  'Apply for the two roles that match the profile.',
  'Install the routine in the Alexa app.',
  'Book the flight for the October trip.',
  'Order the intercoms from the vendor.',
  'Place the order once you name a max price.',
  'Cancel the subscription before the renewal date.',
];

// MUST NOT MATCH — the four historical false drops, plus ordinary reversible plan prose.
const NEG = [
  // The four joint-oldest tasks this check exists to protect. Verbatim.
  'Draft a ready-to-post Facebook Marketplace listing to sell the old GE Profile PVM9005SJSS (title, specs, price, photos checklist).',
  'Note whether an Outlook/email MCP could automate the follow-up (ties to #259) — draft only, no send.',
  'a paint plan: products, prep/steps, materials list, and a weekend schedule.',
  'Finalize and produce a one-page "where it applies" list: folder name, app title, repo name, and any in-app copy.',
  // Explicit non-performance promises — the strongest reversibility signal there is.
  'I will not send anything — the outreach stays a draft until you approve.',
  'Draft the message but do not email it.',
  'Produce the comparison rather than buying anything.',
  'Shortlist three vendors, stopping short of ordering.',
  // Ordinary reversible plan bodies.
  'Summarize the current state and write up a one-page recommendation.',
  'Research the options and produce a comparison table with prices.',
  'Open a draft PR implementing steps 1-3, with tests.',
  'Generate `journal\\task-204-career-sprint.md` containing the reconciled backlog.',
  'Look up the model number and outline the prep steps.',
  'Audit the existing routines and sketch a mapping table.',
  // Nouns that previously tripped the flat list.
  'Add a post-mortem section to the write-up.',
  'Confirm the email address format before drafting.',
  'Include a schedule of weekend tasks in the plan.',
  'Document where the naming convention applies across the repos.',
  'Order of operations: research first, then compare.',
  'Read the book and summarize the three key ideas.',
];

let ok = true;
console.log('--- POSITIVES (must all match) ---');
for (const s of POS) {
  const h = hit(s);
  if (!h) ok = false;
  console.log(`${h ? 'PASS' : 'FAIL'}  ${s.slice(0, 78)}`);
}
console.log('\n--- NEGATIVES (must all NOT match) ---');
for (const s of NEG) {
  const m = matchIrreversible(strip(s));
  if (m) ok = false;
  console.log(`${m ? `FAIL[${m}]` : 'PASS'}  ${s.slice(0, 72)}`);
}
console.log(`\nRESULT: ${ok ? 'ALL GOOD' : 'DEFECT — fix the matcher before trusting it'}`);
process.exit(ok ? 0 : 1);
