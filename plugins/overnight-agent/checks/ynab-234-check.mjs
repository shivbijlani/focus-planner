// ynab-234-audit.mjs - READ-ONLY audit of task #234's three pending memo groups.
// Never writes: no PATCH/POST/DELETE here.
//
//   node ynab-234-audit.mjs
//
// #234's plan (2026-08-25) proposed memo-ing 44 untagged Vacation rows:
//   A) the Jul 15-23 blank-memo set minus 3 Alaska rows -> "NY Jul 2026"  (30 rows, -729.94)
//   B) the 3 Jul 18 Alaska rows                          -> "LA Aug 2026" ( 3 rows, -1071.88)
//   C) the Aug 16-22 posting-lag set                     -> "LA Aug 2026" (11 rows)
// Live now shows 55 untagged, so this prints every untagged row bucketed by
// whether #234's plan actually covers it - the residue is what matters.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_PATHS = [
  path.join(os.homedir(), '.copilot', 'skills', 'ynab-amazon-categorizer', '.ynab_token'),
  path.join(os.homedir(), '.ynab', 'token.txt'),
];

function readToken() {
  if (process.env.YNAB_TOKEN) return process.env.YNAB_TOKEN.trim();
  for (const p of TOKEN_PATHS) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  throw new Error(`No YNAB token found. Looked in:\n  ${TOKEN_PATHS.join('\n  ')}`);
}

const TOKEN = readToken();
const H = { Authorization: `Bearer ${TOKEN}` };
const money = (milli) => (milli / 1000).toFixed(2);

async function api(pathname) {
  const res = await fetch(`https://api.ynab.com/v1${pathname}`, { headers: H });
  if (!res.ok) throw new Error(`YNAB ${res.status} on ${pathname}: ${await res.text()}`);
  return (await res.json()).data;
}

const { budgets } = await api('/budgets');
const budget = budgets[0];

const { category_groups } = await api(`/budgets/${budget.id}/categories`);
const vacation = category_groups
  .flatMap((g) => g.categories)
  .find((c) => c.name === 'Vacation' && !c.deleted);

const { transactions } = await api(
  `/budgets/${budget.id}/categories/${vacation.id}/transactions?since_date=2026-01-01`
);

const untagged = transactions.filter((t) => !(t.memo || '').trim());

// #234's three groups, by the criteria the journal states.
const isAlaskaJul18 = (t) =>
  t.date === '2026-07-18' && /alaska/i.test(t.payee_name || '');
const inJul15to23 = (t) => t.date >= '2026-07-15' && t.date <= '2026-07-23';
const inAug16to22 = (t) => t.date >= '2026-08-16' && t.date <= '2026-08-22';

const groupB = untagged.filter(isAlaskaJul18);
const groupA = untagged.filter((t) => inJul15to23(t) && !isAlaskaJul18(t));
const groupC = untagged.filter(inAug16to22);
const covered = new Set([...groupA, ...groupB, ...groupC].map((t) => t.id));
const residue = untagged.filter((t) => !covered.has(t.id));

const show = (label, rows, memo) => {
  const tot = rows.reduce((s, t) => s + t.amount, 0);
  console.log(`\n== ${label} == ${rows.length} rows, ${money(tot)}${memo ? `  -> memo "${memo}"` : ''}`);
  for (const t of rows.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(
      `   ${t.date}  ${money(t.amount).padStart(10)}  ${(t.payee_name || '(no payee)').slice(0, 38).padEnd(38)}  ${t.account_name}`
    );
  }
};

console.log(`budget: ${budget.name}`);
console.log(`Vacation total (since 2026-01-01): ${money(transactions.reduce((s, t) => s + t.amount, 0))} over ${transactions.length} rows`);
console.log(`UNTAGGED (blank memo): ${untagged.length} rows, ${money(untagged.reduce((s, t) => s + t.amount, 0))}`);

show('GROUP A  Jul 15-23 non-Alaska', groupA, 'NY Jul 2026');
show('GROUP B  Jul 18 Alaska', groupB, 'LA Aug 2026');
show('GROUP C  Aug 16-22 posting-lag', groupC, 'LA Aug 2026');
show('RESIDUE  untagged but NOT covered by #234 plan', residue, null);

console.log(`\nSUMMARY: plan covers ${covered.size} of ${untagged.length} untagged rows; residue = ${residue.length}.`);

// Memo-convention drift: near-duplicate trip labels.
const labels = new Map();
for (const t of transactions) {
  const m = (t.memo || '').trim();
  if (!m) continue;
  labels.set(m, (labels.get(m) || 0) + 1);
}
const rare = [...labels.entries()].filter(([, n]) => n <= 2).sort();
if (rare.length) {
  console.log(`\nMEMO-CONVENTION OUTLIERS (labels used on <=2 rows - possible typos):`);
  for (const [l, n] of rare) console.log(`   "${l}"  x${n}`);
}
