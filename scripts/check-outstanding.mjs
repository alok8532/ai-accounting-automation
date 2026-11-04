// Read-only: bill-wise receivables with due date and overdue days.
// Usage: node scripts/check-outstanding.mjs [asOf=YYYY-MM-DD]

import { getReceivables, fmtDate } from "../lib/receivables.mjs";

const asOf = new Date(process.argv[2] ?? new Date().toISOString().slice(0, 10));

async function main() {
  const rows = await getReceivables(asOf);
  console.log(`Bill-wise receivables as of ${fmtDate(asOf)}`);
  console.table(rows);
  console.log("Total outstanding:", rows.reduce((s, r) => s + r.outstanding, 0).toLocaleString("en-IN"));
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
