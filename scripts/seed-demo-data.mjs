// Step 2: Seed "Demo Trading Co" with test masters + invoices.
// Usage: node scripts/seed-demo-data.mjs
//
// SAFETY
//  - Refuses to run against any company other than the demo company.
//  - Idempotent: masters are created only if missing; each voucher carries a
//    "[seed:ID]" tag in its narration and is skipped if that tag already exists.
//  - All emails use the reserved example.com domain, so no real person can ever
//    receive a draft generated from this data.

import { COMPANY, esc, decode, postXml, collectionRequest, importData } from "../lib/tally.mjs";

if (COMPANY !== "Demo Trading Co") {
  console.error(`Refusing to seed company "${COMPANY}". This script is for the demo company only.`);
  process.exit(1);
}

// ---------- Demo data ----------
// Retainer customers live in their own sub-group. That group IS the "Retainer customer
// marker" from the proposal: visible in Tally, set by accountants, no guessing from names.
const RETAINER_GROUP = "Retainer Customers";

const customers = [
  { name: "Sharma Exports Pvt Ltd", group: RETAINER_GROUP, credit: 15, email: "accounts@sharma-exports.example.com" },
  { name: "Gupta Healthcare",       group: RETAINER_GROUP, credit: 30, email: "finance@gupta-health.example.com" },
  { name: "Verma Textiles",         group: RETAINER_GROUP, credit: 30, email: "billing@verma-textiles.example.com" },
  { name: "Kapoor Builders",        group: "Sundry Debtors", credit: 30, email: "accounts@kapoor-builders.example.com" },
  { name: "Singh Logistics",        group: "Sundry Debtors", credit: 45, email: "ap@singh-logistics.example.com" },
  { name: "Mehta Retail",           group: "Sundry Debtors", credit: 30, email: "payables@mehta-retail.example.com" },
];

const otherLedgers = [
  { name: "Consulting Income", parent: "Sales Accounts" },
  { name: "Output CGST 9%",    parent: "Duties & Taxes" },
  { name: "Output SGST 9%",    parent: "Duties & Taxes" },
  { name: "HDFC Bank",         parent: "Bank Accounts" },
];

// Educational Mode only allows voucher dates on the 1st/2nd of a month.
// Amounts are taxable value; 9% CGST + 9% SGST are added (intra-state, UP).
const sales = [
  { id: "DEMO-001", date: "20260601", party: "Kapoor Builders",        amount: 50000, note: "Site advisory - May" },
  { id: "DEMO-002", date: "20260701", party: "Singh Logistics",        amount: 80000, note: "Route optimisation project" },
  { id: "DEMO-003", date: "20260801", party: "Sharma Exports Pvt Ltd", amount: 25000, note: "Retainer - Aug 2026" },
  { id: "DEMO-004", date: "20260802", party: "Mehta Retail",           amount: 12000, note: "POS consulting" },
  { id: "DEMO-005", date: "20260901", party: "Gupta Healthcare",       amount: 40000, note: "Retainer - Sep 2026" },
  { id: "DEMO-006", date: "20260901", party: "Sharma Exports Pvt Ltd", amount: 25000, note: "Retainer - Sep 2026" },
  { id: "DEMO-007", date: "20261001", party: "Verma Textiles",         amount: 15000, note: "Retainer - Oct 2026" },
  { id: "DEMO-008", date: "20261001", party: "Gupta Healthcare",       amount: 40000, note: "Retainer - Oct 2026" },
  { id: "DEMO-009", date: "20261002", party: "Kapoor Builders",        amount: 20000, note: "Site advisory - Sep" },
  { id: "DEMO-010", date: "20261102", party: "Mehta Retail",           amount:  8000, note: "POS consulting - follow-up" },
];

// Receipts: one full payment, one partial payment (both "Agst Ref" = against a bill),
// one advance (new "Advance" reference, adjusted later) and one "On Account" receipt (not linked to any bill).
const receipts = [
  { id: "DEMO-R01", date: "20260901", party: "Sharma Exports Pvt Ltd", bill: "DEMO-003", amount: 29500, note: "Full payment" },
  { id: "DEMO-R02", date: "20260801", party: "Singh Logistics",        bill: "DEMO-002", amount: 30000, note: "Part payment" },
  { id: "DEMO-R03", date: "20261101", party: "Mehta Retail",           bill: "ADV-MEHTA-01", type: "Advance", amount: 5000, note: "Advance received" },
  { id: "DEMO-R04", date: "20261101", party: "Verma Textiles",         type: "On Account", amount: 20000, note: "Payment received, bill not specified" },
];

// Credit notes (voucher type "Credit Note"): one adjusted against a bill, one left as a new credit reference.
// amount = taxable value; 9% CGST + 9% SGST reversed on top.
const creditNotes = [
  { id: "DEMO-CN1", date: "20261102", party: "Kapoor Builders",  bill: "DEMO-009",     type: "Agst Ref", amount: 5000, note: "Rate difference on DEMO-009" },
  { id: "DEMO-CN2", date: "20261101", party: "Gupta Healthcare", bill: "CN-GUPTA-01",  type: "New Ref",  amount: 2000, note: "Service credit - not yet adjusted" },
];

// ---------- Helpers ----------
const names = async (type) => {
  const xml = await postXml(collectionRequest(`Existing${type}`, type, ["Name"]));
  return new Set([...xml.matchAll(new RegExp(`<${type.toUpperCase()} NAME="([^"]*)"`, "g"))].map((m) => decode(m[1])));
};

const report = (label, r) => {
  console.log(`  ${label}: created=${r.created} altered=${r.altered} errors=${r.errors}`);
  r.lineErrors.forEach((e) => console.log("    ! " + e));
  if (r.errors) throw new Error(`${label} import had errors — stopping.`);
};

const ledgerEntry = (ledger, amount, bill) => `
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(ledger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>${amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <AMOUNT>${amount}</AMOUNT>${bill ?? ""}
  </ALLLEDGERENTRIES.LIST>`;

// Tally stores dates as a day number "JD" = days since 31-Dec-1899 (1-Jun-2026 = 46173).
const tallyJD = (yyyymmdd) => {
  const [y, m, d] = [yyyymmdd.slice(0, 4), yyyymmdd.slice(4, 6), yyyymmdd.slice(6, 8)].map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 31)) / 86400000);
};

// Bill credit period = JD (bill date) + P (period label); due date = JD + P.
// Without the P attribute Tally silently stores due date = bill date (breaks ageing).
const billAlloc = (name, type, amount, creditDays, billDate) => `
    <BILLALLOCATIONS.LIST>
      ${name ? `<NAME>${esc(name)}</NAME>` : ""}<BILLTYPE>${type}</BILLTYPE>
      ${creditDays ? `<BILLCREDITPERIOD JD="${tallyJD(billDate)}" P="${creditDays} Days">${creditDays} Days</BILLCREDITPERIOD>` : ""}
      <AMOUNT>${amount}</AMOUNT>
    </BILLALLOCATIONS.LIST>`;

// In Tally XML, debit amounts are negative and credit amounts positive.
function salesVoucher(s) {
  const cust = customers.find((c) => c.name === s.party);
  const gst = Math.round(s.amount * 0.09);
  const total = s.amount + 2 * gst;
  return `<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>${s.date}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${s.id}</VOUCHERNUMBER><REFERENCE>${s.id}</REFERENCE>
  <PARTYLEDGERNAME>${esc(s.party)}</PARTYLEDGERNAME>
  <NARRATION>${esc(s.note)} [seed:${s.id}]</NARRATION>
  <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
  ${ledgerEntry(s.party, -total, billAlloc(s.id, "New Ref", -total, cust.credit, s.date))}
  ${ledgerEntry("Consulting Income", s.amount)}
  ${ledgerEntry("Output CGST 9%", gst)}
  ${ledgerEntry("Output SGST 9%", gst)}
</VOUCHER>`;
}

function receiptVoucher(r) {
  return `<VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>${r.date}</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${r.id}</VOUCHERNUMBER>
  <PARTYLEDGERNAME>${esc(r.party)}</PARTYLEDGERNAME>
  <NARRATION>${esc(r.note)}${r.bill ? ` - ${r.bill}` : ""} [seed:${r.id}]</NARRATION>
  <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
  ${ledgerEntry(r.party, r.amount, billAlloc(r.bill, r.type ?? "Agst Ref", r.amount))}
  ${ledgerEntry("HDFC Bank", -r.amount)}
</VOUCHER>`;
}

// Credit note: customer credited (positive), income and output GST reversed (debited, negative).
function creditNoteVoucher(c) {
  const gst = Math.round(c.amount * 0.09);
  const total = c.amount + 2 * gst;
  return `<VOUCHER VCHTYPE="Credit Note" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>${c.date}</DATE><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${c.id}</VOUCHERNUMBER>
  <PARTYLEDGERNAME>${esc(c.party)}</PARTYLEDGERNAME>
  <NARRATION>${esc(c.note)} [seed:${c.id}]</NARRATION>
  <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
  ${ledgerEntry(c.party, total, billAlloc(c.bill, c.type, total))}
  ${ledgerEntry("Consulting Income", -c.amount)}
  ${ledgerEntry("Output CGST 9%", -gst)}
  ${ledgerEntry("Output SGST 9%", -gst)}
</VOUCHER>`;
}

// ---------- Run ----------
async function main() {
  console.log(`Seeding "${COMPANY}"...`);

  // 1. Group
  const groups = await names("Group");
  if (!groups.has(RETAINER_GROUP)) {
    report("Group", await importData("All Masters", `
      <GROUP NAME="${esc(RETAINER_GROUP)}" ACTION="Create">
        <NAME.LIST><NAME>${esc(RETAINER_GROUP)}</NAME></NAME.LIST>
        <PARENT>Sundry Debtors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON>
      </GROUP>`));
  } else console.log("  Group: already exists");

  // 2. Ledgers (customers + income/tax/bank)
  const ledgers = await names("Ledger");
  const newCustomers = customers.filter((c) => !ledgers.has(c.name));
  const newOthers = otherLedgers.filter((l) => !ledgers.has(l.name));
  if (newCustomers.length + newOthers.length) {
    report("Ledgers", await importData("All Masters",
      newCustomers.map((c) => `
      <LEDGER NAME="${esc(c.name)}" ACTION="Create">
        <NAME.LIST><NAME>${esc(c.name)}</NAME></NAME.LIST>
        <PARENT>${esc(c.group)}</PARENT>
        <ISBILLWISEON>Yes</ISBILLWISEON>
        <BILLCREDITPERIOD>${c.credit} Days</BILLCREDITPERIOD>
        <EMAIL>${esc(c.email)}</EMAIL>
        <LEDSTATENAME>Uttar Pradesh</LEDSTATENAME><COUNTRYNAME>India</COUNTRYNAME>
      </LEDGER>`).join("") +
      newOthers.map((l) => `
      <LEDGER NAME="${esc(l.name)}" ACTION="Create">
        <NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>
        <PARENT>${esc(l.parent)}</PARENT>
      </LEDGER>`).join("")));
  } else console.log("  Ledgers: already exist");

  // 3. Vouchers — skip any whose [seed:ID] tag is already in Tally (duplicate prevention).
  const vxml = await postXml(collectionRequest("SeedVouchers", "Voucher", ["Narration"],
    { from: "20260401", to: "20270331" }));
  const done = new Set([...vxml.matchAll(/\[seed:([A-Z0-9-]+)\]/g)].map((m) => m[1]));

  const todoSales = sales.filter((s) => !done.has(s.id));
  const todoReceipts = receipts.filter((r) => !done.has(r.id));
  if (todoSales.length) report(`Sales (${todoSales.length})`, await importData("Vouchers", todoSales.map(salesVoucher).join("")));
  else console.log("  Sales: already seeded");
  if (todoReceipts.length) report(`Receipts (${todoReceipts.length})`, await importData("Vouchers", todoReceipts.map(receiptVoucher).join("")));
  else console.log("  Receipts: already seeded");
  const todoCredits = creditNotes.filter((c) => !done.has(c.id));
  if (todoCredits.length) report(`Credit notes (${todoCredits.length})`, await importData("Vouchers", todoCredits.map(creditNoteVoucher).join("")));
  else console.log("  Credit notes: already seeded");

  console.log("Done.");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
