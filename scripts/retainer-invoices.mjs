// Read-only preview of this month's (or a given month's) Retainer invoices.
// Usage: npm run invoices:preview [YYYY-MM]
// Creating invoices is done from Claude (create_retainer_invoices), after a confirmed preview.

import { previewRetainerInvoices, inr, dmy } from "../lib/retainer-invoices.mjs";

try {
  const p = await previewRetainerInvoices({ period: process.argv[2] });
  console.log(`Retainer invoices — ${p.periodName} — company "${p.company}" — invoice date ${dmy(p.invoiceDate)}`);
  console.table(p.rows.map((r) => ({
    Customer: r.customer, "Bill ref": r.billRef ?? "-", Fee: r.fee != null ? inr(r.fee) : "-",
    GST: r.fee != null ? inr(r.cgst + r.sgst) : "-", Total: r.total != null ? inr(r.total) : "-",
    Due: r.dueDate ? dmy(r.dueDate) : "-", Status: r.status,
  })));
  for (const r of p.rows) for (const m of [...(r.issues ?? []), ...(r.notes ?? [])]) console.log(`  ${r.customer}: ${m}`);
  for (const w of p.warnings) console.log(`  Warning: ${w}`);
  if (p.rows.some((r) => r.existing)) for (const r of p.rows.filter((x) => x.existing))
    console.log(`  ${r.customer}: already invoiced — voucher ${r.existing.voucherNumber} (${r.existing.source})`);
  console.log(`\nReady: ${p.counts.ready}, total ${inr(p.totals.total)}. Creating is ${p.writeEnabled ? "ENABLED" : "switched off (INVOICE_WRITE_ENABLED)"}.`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
