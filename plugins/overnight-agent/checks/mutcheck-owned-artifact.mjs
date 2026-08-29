// mutation check for the owned-artifact-identity arm of self-answerable-sweep.mjs
// Positives are the LITERAL ask strings that were missed (#196, #390) plus close variants.
// Negatives are real asks drawn from the live backlog that must NOT flood the sweep.
const ARM = [
  [/\b(make|brand)\s*(\+|and|\/|,)\s*model\b/i, 'owned-artifact-identity'],
  [/\bmodel\s*(#|number|no\.?)\b/i, 'owned-artifact-identity'],
  [/\bserial\s*(#|number|no\.?)\b/i, 'owned-artifact-identity'],
  [/\b(what|which)\s+(brand|make)\b/i, 'owned-artifact-identity'],
  [/\b(what|which)\s+model\s+(is|are)\b/i, 'owned-artifact-identity'],
];
const hit = (s) => ARM.some(([re]) => re.test(s));

const POS = [
  // #196, literal
  'washer make/model and the symptom (mold smell, visible tear, or leak).',
  // #390, literal
  'the dryer **brand + model number** (and ideally a photo of the felt seal) so I can pull the exact part.',
  'the model number off the sticker inside the door',
  'what brand is the water heater?',
  'what model is the water heater?',
  'the serial number on the back panel',
  'the make and model of the mower',
];

const NEG = [
  // Real asks from the live backlog — none of these should trip the arm.
  'one word — **`merge 168`** and I will land the stack.',
  'nothing to unblock it. Two optional calls when you are ready:',
  'the approval gate below — which to merge / build next.',
  'were both sets of tires mounted on the same four rims?',
  'has either of you actually been tested for a latex allergy?',
  'two answers whenever you are next at the fridge',
  'one of two, whichever you prefer — (a) sign the MCP Edge bijlanis window',
  'reply with the letters you want (e.g. "a + b, all history")',
  'paste your current Career Hub profile/interests text',
  'confirm Jody\'s name spelling + the two garbled household names, then forward.',
  'a decision on which model of engagement you want with Scott',   // "model of engagement" - must NOT match
  'which approach do you prefer?',
  'download your SCL usage/bill detail so I can compute real numbers',
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
