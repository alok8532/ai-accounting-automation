// Read-only check of our receivables maths against TallyPrime itself. Run with Tally open.
// Usage: node scripts/probe-tally.mjs
//
//  1. Saves the raw XML Tally returns (groups, ledgers, bills, vouchers, Bills Receivable report)
//     to reports/probe/<timestamp>/ — evidence for review and the source for test fixtures.
//  2. Compares our bill balances / due dates / overdue days with Tally's own "Bills Receivable" report.
//  3. Tests whether Tally honours a past date for bill balances (decides if allowPastAsOf can be enabled).
// Sends ONLY Export requests. Nothing is written to Tally.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPANY, esc, decode, postXml, collectionRequest } from "../lib/tally.mjs";
import { loadReceivables, field } from "../lib/receivables.mjs";
import { businessDate } from "../lib/dates.mjs";
import { ROOT } from "../lib/config.mjs";

const today = businessDate();
const dir = join(ROOT, "reports", "probe", new Date().toISOString().replace(/[:.]/g, "-"));

// Tally's built-in report, exported as XML (read-only "Export Data" request).
const reportRequest = (report, vars = "") => `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${report}</REPORTNAME>
    <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY>${vars}</STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const tallyDate = (s) => { // "1-Jul-2026" / "1-Jul-26" -> "2026-07-01"
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  return m ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}` : s.trim();
};

async function save(name, xml) {
  await writeFile(join(dir, name), xml, "utf8");
  return xml;
}

async function main() {
  await mkdir(dir, { recursive: true });
  console.log(`Probing "${COMPANY}" (read-only). Raw XML -> ${dir}\n`);

  await save("groups.xml", await postXml(collectionRequest("G", "Group", ["Name", "Parent"])));
  await save("ledgers.xml", await postXml(collectionRequest("L", "Ledger",
    ["Name", "Parent", "Email", "ClosingBalance", "IsBillWiseOn", "BillCreditPeriod"])));
  await save("bills.xml", await postXml(collectionRequest("B", "Bill",
    ["Name", "Parent", "BillDate", "BillDueDate", "ClosingBalance", "OpeningBalance"])));
  await save("vouchers.xml", await postXml(collectionRequest("VH", "Voucher",
    ["Date", "VoucherTypeName", "VoucherNumber", "PartyLedgerName", "Amount"])));
  const br = await save("bills-receivable-report.xml", await postXml(reportRequest("Bills Receivable",
    `<SVTODATE>${today.replaceAll("-", "")}</SVTODATE>`)).catch((e) => {
    console.log(`! Could not export Tally's Bills Receivable report (${e.message})`);
    return "";
  }));

  // --- 2. Compare with Tally's Bills Receivable report ---
  const ours = await loadReceivables(today);
  const tallyRows = [...br.matchAll(/<BILLFIXED>([\s\S]*?)<\/BILLFIXED>([\s\S]*?)(?=<BILLFIXED>|<\/ENVELOPE>)/g)].map(([, fixed, rest]) => ({
    party: decode(field(fixed, "BILLPARTY")),
    bill: decode(field(fixed, "BILLREF")),
    billDate: tallyDate(decode(field(fixed, "BILLDATE"))),
    balance: -Number(field(rest, "BILLCL") || 0),
    dueDate: tallyDate(decode(field(rest, "BILLDUE"))),
    overdue: Number(field(rest, "BILLOVERDUE") || 0),
  }));
  if (!tallyRows.length) {
    console.log("! Could not read rows from Tally's Bills Receivable report — compare manually with bills-receivable-report.xml");
  } else {
    const key = (p, b) => `${p}\u0000${b}`;
    const mine = new Map([...ours.rows.map((r) => [key(r.customer, r.bill), r]),
      ...ours.credits.map((c) => [key(c.customer, c.bill), { ...c, outstanding: -c.amount }])]);
    const diffs = [];
    for (const t of tallyRows) {
      const r = mine.get(key(t.party, t.bill));
      if (!r) { diffs.push(`${t.party} / ${t.bill}: in Tally report, missing in ours`); continue; }
      mine.delete(key(t.party, t.bill));
      if (Math.abs(r.outstanding - t.balance) >= 0.01) diffs.push(`${t.party} / ${t.bill}: balance Tally ${t.balance} vs ours ${r.outstanding}`);
      if (r.dueDate !== undefined && t.dueDate && r.dueDate !== t.dueDate) diffs.push(`${t.party} / ${t.bill}: due date Tally ${t.dueDate} vs ours ${r.dueDate} (${r.dueDateSource})`);
      if (r.overdueDays != null && t.overdue && r.overdueDays !== t.overdue) diffs.push(`${t.party} / ${t.bill}: overdue days Tally ${t.overdue} vs ours ${r.overdueDays}`);
    }
    for (const r of mine.values()) diffs.push(`${r.customer} / ${r.bill}: in ours, not in Tally report`);
    console.log(`Bills Receivable: Tally ${tallyRows.length} bills, ours ${ours.rows.length} open + ${ours.credits.length} credit.`);
    console.log(diffs.length ? "DIFFERENCES:\n - " + diffs.join("\n - ") : "✓ Every bill matches Tally (balance, due date, overdue days).");
  }

  // Ledger balance vs bills: anything not linked to a bill is "on account".
  for (const [name, v] of ours.onAccount) console.log(`On account: ${name} ${v > 0 ? "debit" : "credit"} ₹${Math.abs(v)}`);
  const noDefault = [...ours.ledgers].filter(([, l]) => l.debtor && l.defaultCreditDays == null).map(([n]) => n);
  if (noDefault.length) console.log(`Ledgers without a default credit period: ${noDefault.join(", ")}`);

  // --- 3. Does Tally give bill balances as of a past date? ---
  const past = new Date(Date.now() - 60 * 86400000);
  const pastYmd = businessDate(past).replaceAll("-", "");
  const pastBills = await save("bills-60-days-ago.xml", await postXml(collectionRequest("B", "Bill",
    ["Name", "Parent", "ClosingBalance"], { from: "19000101", to: pastYmd })));
  const nowBills = await postXml(collectionRequest("B", "Bill", ["Name", "Parent", "ClosingBalance"]));
  const bal = (x) => [...x.matchAll(/<BILL NAME="[^"]*"[\s\S]*?<\/BILL>/g)].map(([b]) => field(b, "CLOSINGBALANCE")).join("|");
  console.log(bal(pastBills) === bal(nowBills)
    ? "\nPast-date test: Tally returned the SAME bill balances for 60 days ago → keep allowPastAsOf = false."
    : "\nPast-date test: balances differ for 60 days ago → Tally may support past dates; review before enabling allowPastAsOf.");
}

main().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
