// ynab-vacation-report.mjs — READ-ONLY per-trip vacation report from YNAB.
// Task #222 (ynab vacation tracker). Never writes: no PATCH/POST/DELETE here.
//
//   node ynab-vacation-report.mjs [--since 2026-01-01]
//
// Trip attribution comes from the transaction MEMO, using the convention
//   "<Trip> <Mon YYYY>"   e.g. "NY Jul 2026", "LA Aug 2026"
// Anything in the Vacation category with a blank memo is reported as UNTAGGED,
// which is the number that tells you the tracker has drifted.

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

const sinceArg = process.argv.indexOf('--since');
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-01-01';
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
if (!vacation) throw new Error('No category named "Vacation" in this budget.');

const { transactions } = await api(
  `/budgets/${budget.id}/categories/${vacation.id}/transactions?since_date=${SINCE}`
);

const trips = new Map();
for (const t of transactions) {
  const key = (t.memo || '').trim() || '(UNTAGGED)';
  if (!trips.has(key)) trips.set(key, { n: 0, total: 0, first: t.date, last: t.date });
  const row = trips.get(key);
  row.n += 1;
  row.total += t.amount;
  if (t.date < row.first) row.first = t.date;
  if (t.date > row.last) row.last = t.date;
}

const rows = [...trips.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first));
const gross = transactions.reduce((s, t) => s + t.amount, 0);
const untagged = trips.get('(UNTAGGED)') ?? { n: 0, total: 0 };

console.log(`budget: ${budget.name}   Vacation category since ${SINCE}`);
console.log(`${'trip'.padEnd(22)} ${'from'.padEnd(10)} ${'to'.padEnd(10)} ${'n'.padStart(4)} ${'total'.padStart(11)}`);
console.log('-'.repeat(62));
for (const [name, r] of rows) {
  console.log(`${name.padEnd(22)} ${r.first.padEnd(10)} ${r.last.padEnd(10)} ${String(r.n).padStart(4)} ${money(r.total).padStart(11)}`);
}
console.log('-'.repeat(62));
console.log(`${'GROSS'.padEnd(22)} ${''.padEnd(21)} ${String(transactions.length).padStart(4)} ${money(gross).padStart(11)}`);
console.log(`${'UNTAGGED'.padEnd(22)} ${''.padEnd(21)} ${String(untagged.n).padStart(4)} ${money(untagged.total).padStart(11)}`);

const pct = transactions.length ? ((untagged.n / transactions.length) * 100).toFixed(0) : '0';
console.log(`\nuntagged share: ${pct}% of transactions — anything above ~5% means the memo convention has drifted.`);
if (!vacation.goal_type) {
  console.log('note: the Vacation category has NO target set, so YNAB shows no progress bar for it.');
}
