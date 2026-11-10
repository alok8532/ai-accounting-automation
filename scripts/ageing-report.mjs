// Outstanding ageing report -> console summary + CSV files (open in Excel). Read-only on Tally.
// Usage: node scripts/ageing-report.mjs [YYYY-MM-DD] [--no-payments]
//   writes reports/ageing-<date>-customers.csv and reports/ageing-<date>-bills.csv

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ageingView } from "../lib/report.mjs";
import { ROOT } from "../lib/config.mjs";

const args = process.argv.slice(2);
const asOf = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const includePayments = !args.includes("--no-payments");

const inr = (n) => (n < 0 ? "-" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const cell = (v) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"; // BOM: Excel reads ₹ correctly

async function main() {
  const v = await ageingView({ asOf, includePayments });
  const { report } = v;
  const labels = report.bucketLabels;

  console.log(`Outstanding ageing as of ${report.asOf} (days overdue from due date)\n`);
  console.table(report.customers.map((c) => ({
    Customer: c.customer, Retainer: c.retainer, ...Object.fromEntries(labels.map((l) => [l, c.buckets[l] || ""])),
    Credits: c.unadjustedCredits || "", "Net due": c.netDue, Hold: c.hold ? "yes" : "", Email: c.emailStatus,
  })));
  console.log("Totals:", Object.entries(report.totals.buckets).map(([k, n]) => `${k} ${inr(n)}`).join(" | "));
  console.log(`Bills ${inr(report.totals.totalBills)} − credit bills ${inr(report.totals.creditBills)} ` +
    `+ on account ${inr(report.totals.onAccount)} = net due ${inr(report.totals.netDue)}`);
  if (report.warnings.length) console.log("\nWarnings:\n - " + report.warnings.join("\n - "));

  const dir = join(ROOT, "reports");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `ageing-${report.asOf}`);
  await writeFile(`${base}-customers.csv`, csv(
    ["Customer", "Retainer", ...labels, "Unknown due date", "Total bills", "Overdue", "Credit bills (advance/credit note)",
      "On account", "Net due", "Net overdue", "Oldest overdue days", "Hold", "Email", "Email status", "Reminder"],
    [...report.customers.map((c) => [c.customer, c.retainer, ...labels.map((l) => c.buckets[l]), c.unknownDueDate,
      c.totalBills, c.overdueTotal, c.creditBills, c.onAccount, c.netDue, c.netOverdue, c.oldestOverdueDays,
      c.hold ?? "", c.email, c.emailStatus, c.reminder.eligible ? "yes" : c.reminder.reason]),
    ["TOTAL", "", ...labels.map((l) => report.totals.buckets[l]), report.totals.unknownDueDate, report.totals.totalBills,
      report.totals.overdueTotal, report.totals.creditBills, report.totals.onAccount, report.totals.netDue]]), "utf8");
  await writeFile(`${base}-bills.csv`, csv(
    ["Customer", "Retainer", "Bill", "Bill date", "Due date", "Due date source", "Days since bill", "Days overdue",
      "Balance", "Billed", "Adjusted", "Adjustments", "Note"],
    [...v.rows.map((r) => [r.customer, r.retainer, r.bill, r.billDate, r.dueDate, r.dueDateSource ?? "", r.daysSinceBill,
      r.overdueDays ?? "", r.outstanding, r.billed ?? "", r.adjusted ?? "",
      (r.adjustments ?? []).map((a) => `${a.date} ${a.type} ${a.number} ${a.amount}`), r.issue ?? r.historyNote ?? ""]),
    ...v.credits.map((c) => [c.customer, "", c.bill, c.billDate, "", "", "", "", -c.amount, "", "", "",
      "credit balance: advance / unadjusted credit note"])]), "utf8");
  console.log(`\nSaved: ${base}-customers.csv\n       ${base}-bills.csv`);
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
