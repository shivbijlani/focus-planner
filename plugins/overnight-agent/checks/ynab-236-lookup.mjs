// Read-only YNAB lookup for task #236: how were the earbuds paid for on/around 2026-05-16?
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const H = { Authorization: `Bearer ${token}` };
const api = async (p) => {
  const r = await fetch(`https://api.ynab.com/v1${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return (await r.json()).data;
};

const { budgets } = await api('/budgets');
console.log('budgets:', budgets.map((b) => `${b.name}`).join(' | '));

const TARGETS = [95460, 80000];
const TOL = 100; // $0.10

for (const b of budgets) {
  const { transactions } = await api(
    `/budgets/${b.id}/transactions?since_date=2026-05-01`,
  );
  const inWindow = transactions.filter(
    (t) => t.date >= '2026-05-08' && t.date <= '2026-05-26',
  );
  console.log(`\n=== ${b.name}: ${transactions.length} txns since 2026-05-01, ${inWindow.length} in 05-08..05-26 ===`);

  const amtHits = inWindow.filter((t) =>
    TARGETS.some((x) => Math.abs(Math.abs(t.amount) - x) <= TOL),
  );
  const nameHits = transactions.filter((t) =>
    /facebook|meta|marketplace|paypal|earbud|buds|sony|bose|jabra|samsung/i.test(
      `${t.payee_name || ''} ${t.memo || ''}`,
    ) && t.date >= '2026-04-25' && t.date <= '2026-06-15',
  );

  const show = (label, list) => {
    console.log(`-- ${label}: ${list.length}`);
    for (const t of list) {
      console.log(
        `   ${t.date}  ${(t.amount / 1000).toFixed(2).padStart(10)}  ` +
          `${(t.payee_name || '(no payee)').slice(0, 38).padEnd(38)}  ` +
          `acct=${(t.account_name || '').slice(0, 26).padEnd(26)}  ` +
          `memo=${(t.memo || '').slice(0, 40)}`,
      );
    }
  };
  show('AMOUNT match ($95.46 / $80.00)', amtHits);
  show('PAYEE/MEMO match (FB/Meta/PayPal/earbuds)', nameHits);

  // Anything in the plausible range on the exact day, as a fallback.
  const sameDay = inWindow.filter((t) => t.date === '2026-05-16');
  show('ALL transactions dated 2026-05-16', sameDay);
}
