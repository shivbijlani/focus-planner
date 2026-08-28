// mutation check for the contact-detail arm of self-answerable-sweep.mjs (added 2026-08-26).
//
// WHY THIS ARM EXISTS
// -------------------
// #289 was the longest-stalled task on the board — 39 days — parked on:
//   "confirm Jody's name spelling + the two garbled household names, then forward.
//    (Separately, still: sender inbox + phone for the two dental record-requests.)"
// Both halves were answerable from Shiv's own records: the attorney's spelling was in her
// signature block in the case folder's saved `thread.md` (JODY REICH LAW, PLLC), and the
// phone was one Google Contacts lookup (+1 206-250-7217). No existing arm matched it.
//
// ⚠️ THE TRAP THIS ENCODES: that exact ask was sitting in mutcheck-owned-artifact.mjs's
// NEGATIVE list. It IS a correct negative *for that arm* — and it is a POSITIVE here. A
// checker's negative corpus is harvested from real unsolved asks, so it can silently certify
// a genuine defect as expected behaviour. Both files are now correct simultaneously, which is
// the point: an ask is only "fine" once every arm has been asked about it.
//
// Positives are the literal missed ask plus close variants. Negatives are real asks drawn from
// the live backlog that must NOT flood the sweep.
const ARM = [
  [/\b(name|surname|first name|last name)['’]?s?\s+spelling\b/i, 'contact-detail'],
  [/\bspelling\s+of\b/i, 'contact-detail'],
  [/\bhow\s+(do\s+you\s+)?spell\b/i, 'contact-detail'],
  [/\b(phone|cell|mobile|telephone)\s*(#|number|no\.?)\b/i, 'contact-detail'],
  [/\b(e-?mail|mailing|postal|street|home)\s+address\b/i, 'contact-detail'],
];
const hit = (s) => ARM.some(([re]) => re.test(s));

const POS = [
  // #289, literal (straight apostrophe, as lib-live-ask returns it)
  "confirm Jody's name spelling + the two garbled household names, then forward. (Separately, still: sender inbox + phone for the two dental record-requests.)",
  // #289, literal (curly apostrophe — journals contain both forms)
  'confirm Jody\u2019s name spelling + the two garbled household names, then forward.',
  // the phone half on its own, as it appeared in the v1 block
  'which inbox the dental emails should go from, and Kiley\'s phone number to fill the [phone] placeholder.',
  'what is her phone number?',
  'his cell number so I can put it on the form',
  'the spelling of the contractor\'s last name',
  'how do you spell her surname?',
  'their email address so I can cc them',
  'the mailing address for the claim packet',
];

const NEG = [
  // Real asks from the live backlog — none of these should trip the arm.
  'one word — **`merge 168`** and I will land the stack.',
  'nothing to unblock it. Two optional calls when you are ready:',
  'the approval gate below — which to merge / build next.',
  'were both sets of tires mounted on the same four rims?',
  'has either of you actually been tested for a latex allergy?',
  'two answers whenever you are next at the fridge',
  'reply with the letters you want (e.g. "a + b, all history")',
  'the dryer **brand + model number** (and ideally a photo of the felt seal)',
  'a decision on which model of engagement you want with Scott',
  'one word — **`cam unlimited`** ($99.99/yr, covers all 6 cameras)',
  'download your SCL usage/bill detail so I can compute real numbers',
  'sign into `login.seattle.gov` in **MCP Edge 1 (CDP 9225)** and leave the portal open',
  // Near-misses that must stay out: these are about routing/choosing, not looking a detail up.
  'which inbox should this go from — the agent address or Kiley\'s?',
  'open the Marketplace order in the Facebook **app** on your phone and tell me the status',
  'tell me the channel and their handle and I will draft it',
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
  const h = hit(s);
  if (h) ok = false;
  console.log(`${h ? 'FAIL' : 'PASS'}  ${s.slice(0, 78)}`);
}
console.log(`\nRESULT: ${ok ? 'ALL GOOD' : 'DEFECT — fix the arm before trusting it'}`);
process.exit(ok ? 0 : 1);
