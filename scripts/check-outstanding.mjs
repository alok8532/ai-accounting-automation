// Read-only: bill-wise receivables with due date and overdue days, plus advances / credits / on account.
// Usage: node scripts/check-outstanding.mjs [asOf=YYYY-MM-DD]
// For the bucket-wise ageing report use: npm run ageing

import { loadReceivables } from "../lib/receivables.mjs";
import { checkAsOf } from "../lib/ageing.mjs";
import { businessDate, fmtDate, toDateOnly } from "../lib/dates.mjs";
import { CONFIG } from "../lib/config.mjs";

const asOf = process.argv[2] ?? businessDate(); // default: today in India time

async function main() {
  checkAsOf(asOf, businessDate(), CONFIG.allowPastAsOf);
  const { rows, credits, onAccount } = await loadReceivables(asOf);
  console.log(`Bill-wise receivables as of ${fmtDate(toDateOnly(asOf))}`);
  console.table(rows.map(({ email, ...r }) => r));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  console.log("Total open bills:", sum(rows, (r) => r.outstanding).toLocaleString("en-IN"));
  if (credits.length) {
    console.log("\nCredit-balance bills (advances / unadjusted credit notes):");
    console.table(credits);
  }
  if (onAccount.size) {
    console.log("\nOn account (ledger balance not linked to any bill; + debit, − credit):");
    console.table([...onAccount].map(([customer, amount]) => ({ customer, amount })));
  }
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
