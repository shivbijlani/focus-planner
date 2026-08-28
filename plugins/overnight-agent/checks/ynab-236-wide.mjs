// Widened read-only YNAB lookup for task #236.
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const H = { Authorization: `Bearer ${token}` };
const api = async (p) => {
  const r = await fetch(`https://api.ynab.com/v1${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return (await r.json()).data;
};

const { budgets } = await api('/budgets');
const b = budgets[0];

const { accounts } = await api(`/budgets/${b.id}/accounts`);
console.log('=== ACCOUNTS YNAB TRACKS (this is the coverage boundary) ===');
for (const a of accounts.filter((x) => !x.deleted)) {
  console.log(
    `  ${a.closed ? '[closed] ' : '[open]   '}${a.name.padEnd(34)} ${a.type.padEnd(14)} ` +
      `bal=${(a.balance / 1000).toFixed(2)}`,
  );
}

const { transactions } = await api(
  `/budgets/${b.id}/transactions?since_date=2026-01-01`,
);
console.log(`\n=== ${transactions.length} transactions since 2026-01-01 ===`);

const TARGETS = [95460, 80000];
console.log('\n-- ANY date in 2026 matching $95.46 or $80.00 (exact) --');
const exact = transactions.filter((t) =>
  TARGETS.some((x) => Math.abs(t.amount) === x),
);
for (const t of exact) {
  console.log(
    `   ${t.date}  ${(t.amount / 1000).toFixed(2).padStart(10)}  ${(t.payee_name || '(none)').slice(0, 40).padEnd(40)} acct=${t.account_name}`,
  );
}
if (!exact.length) console.log('   (none)');

console.log('\n-- ANY PayPal-touching transaction in 2026 --');
const pp = transactions.filter((t) =>
  /paypal/i.test(`${t.payee_name || ''} ${t.memo || ''}`),
);
for (const t of pp) {
  console.log(
    `   ${t.date}  ${(t.amount / 1000).toFixed(2).padStart(10)}  ${(t.payee_name || '').slice(0, 46).padEnd(46)} acct=${t.account_name}`,
  );
}
if (!pp.length) console.log('   (none)');

console.log('\n-- Outflows $70-$110 between 2026-05-10 and 2026-05-22 (widened net) --');
const near = transactions.filter(
  (t) =>
    t.date >= '2026-05-10' &&
    t.date <= '2026-05-22' &&
    t.amount < 0 &&
    Math.abs(t.amount) >= 70000 &&
    Math.abs(t.amount) <= 110000,
);
for (const t of near) {
  console.log(
    `   ${t.date}  ${(t.amount / 1000).toFixed(2).padStart(10)}  ${(t.payee_name || '(none)').slice(0, 40).padEnd(40)} acct=${(t.account_name || '').padEnd(24)} memo=${(t.memo || '').slice(0, 34)}`,
  );
}
if (!near.length) console.log('   (none)');
