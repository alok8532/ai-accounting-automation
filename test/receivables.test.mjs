// Tally parsing + receivables assembly, against the fake Tally (test/fake-tally.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFakeTally, jd } from "./fake-tally.mjs";

let tally, R, D;
before(async () => {
  tally = await startFakeTally();
  process.env.TALLY_URL = tally.url; // must be set before the libs are imported
  process.env.RECEIVABLES_CONFIG = new URL("./test-config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  R = await import("../lib/receivables.mjs");
  D = await import("../lib/dates.mjs");
});
after(() => tally.close());

// Run fn with extra bills in "Tally", then restore.
async function withBills(extra, fn) {
  const saved = tally.state.bills;
  tally.state.bills = [...saved, ...extra];
  try { return await fn(); } finally { tally.state.bills = saved; }
}

test("business date uses India time, not UTC", () => {
  assert.equal(D.businessDate(new Date("2026-11-05T20:00:00Z")), "2026-11-06"); // 01:30 IST next day
  assert.equal(D.businessDate(new Date("2026-11-05T18:00:00Z")), "2026-11-05"); // 23:30 IST
  assert.equal(D.fmtDate(D.toDateOnly("2026-11-05")), "2026-11-05");
  assert.equal(D.fmtDate(D.toDateOnly(new Date("2026-11-05T20:00:00Z"))), "2026-11-06");
});

test("parseBillTerms reads the bill's own terms; bill date and due date stay separate", () => {
  const t = (attrs, extra = "") => R.parseBillTerms(`<BILL>${extra}<BILLDUEDATE TYPE="Due Date" ${attrs}>x</BILLDUEDATE></BILL>`);
  const base = jd("2026-06-01");
  const days = t(`JD="${base}" P="30 Days"`);
  assert.equal(D.fmtDate(days.billDate), "2026-06-01");
  assert.equal(days.creditDays, 30);
  assert.equal(t(`JD="${base}" P="1 Day"`).creditDays, 1);
  assert.equal(t(`JD="${base}" P="45"`).creditDays, 45);
  assert.equal(t(`JD="${base}" P=""`).creditDays, null); // nothing on the bill -> fallback decides later
  assert.equal(t(`JD="${base}"`).creditDays, null);
  assert.equal(D.fmtDate(t(`JD="${base}" P="15-Aug-2026"`).fixedDue), "2026-08-15");
  assert.equal(D.fmtDate(t(`JD="${base}" P="5-Sep-26"`).fixedDue), "2026-09-05");
  assert.match(t(`JD="${base}" P="2 Months"`).issue, /unrecognised credit period "2 Months"/);
  const noJd = R.parseBillTerms(`<BILL><BILLDATE TYPE="Date">20260601</BILLDATE><BILLDUEDATE TYPE="Due Date"/></BILL>`);
  assert.equal(D.fmtDate(noJd.billDate), "2026-06-01"); // bill date from BILLDATE
  assert.equal(R.parseBillTerms("<BILL></BILL>").billDate, null);
});

test("creditDaysOf", () => {
  assert.deepEqual(["30 Days", "1 day", "0", " 45 ", "2 Months", "", null].map(R.creditDaysOf), [30, 1, 0, 45, null, null, null]);
});

test("groupChain walks nested groups and survives cycles", () => {
  const parents = new Map([["Retainer Customers - North", "Retainer Customers"], ["Retainer Customers", "Sundry Debtors"],
    ["Sundry Debtors", "Current Assets"], ["Current Assets", "Primary"], ["Loop A", "Loop B"], ["Loop B", "Loop A"]]);
  assert.deepEqual(R.groupChain("Retainer Customers - North", parents),
    ["Retainer Customers - North", "Retainer Customers", "Sundry Debtors", "Current Assets", "Primary"]);
  assert.deepEqual(R.groupChain("Loop A", parents), ["Loop A", "Loop B"]);
});

test("getLedgers: group tree flags, balance, bill-wise and default credit period", async () => {
  const l = await R.getLedgers();
  assert.deepEqual(l.get("Gupta Healthcare"), {
    group: "Retainer Customers - North", email: "finance@gupta-health.example.com", debtor: true, retainer: true,
    balance: 44840, billWise: true, defaultCreditDays: 30 });
  assert.equal(l.get("Kapoor Builders").retainer, false);
  assert.equal(l.get("Verma Textiles").balance, -2300); // in credit: on-account receipt > bill
  assert.equal(l.get("A & B Traders").defaultCreditDays, null);
  assert.equal(l.get("Paper Supplier").debtor, false);
});

test("loadReceivables: open bills with ageing, part payments, due-date source", async () => {
  const { rows } = await R.loadReceivables("2026-11-05");
  const by = (b, c) => rows.find((r) => r.bill === b && (!c || r.customer === c));
  assert.deepEqual(by("DEMO-001"), {
    bill: "DEMO-001", customer: "Kapoor Builders", retainer: "", billDate: "2026-06-01", dueDate: "2026-07-01",
    overdueDays: 127, outstanding: 59000, email: "accounts@kapoor-builders.example.com", emailStatus: "valid",
    dueDateSource: "bill credit period", daysSinceBill: 157 });
  assert.equal(by("DEMO-002").outstanding, 64400); // balance after part payment
  assert.equal(by("DEMO-002").dueDate, "2026-08-15");
  assert.equal(by("DEMO-009").outstanding, 17700); // after credit note against the bill
  assert.equal(by("DEMO-009").overdueDays, 4);
  assert.equal(by("DEMO-005").retainer, "yes"); // nested Retainer sub-group
  assert.equal(by("DEMO-004").emailStatus, "missing");
  assert.equal(by("DEMO-003"), undefined); // fully paid
  assert.equal(by("ADV-1"), undefined); // supplier advance is not a receivable
  assert.ok(by("1", "A & B Traders") && by("1", "A-B Traders"));
  const days = rows.map((r) => r.overdueDays);
  assert.deepEqual(days, [...days].sort((a, b) => b - a)); // most overdue first
});

test("loadReceivables: advances / credit notes and on-account amounts", async () => {
  const { rows, credits, onAccount } = await R.loadReceivables("2026-11-05");
  assert.deepEqual(credits.map((c) => [c.customer, c.bill, c.amount]).sort(), [
    ["Gupta Healthcare", "CN-GUPTA-01", 2360],
    ["Mehta Retail", "ADV-MEHTA-01", 5000],
  ]);
  assert.ok(!rows.some((r) => r.bill === "CN-GUPTA-01" || r.bill === "ADV-MEHTA-01"));
  assert.deepEqual([...onAccount], [["Verma Textiles", -20000]]); // on-account receipt not linked to a bill
});

test("a bill with no credit period uses the ledger default — flagged", () =>
  withBills([{ name: "NOCP-1", party: "Singh Logistics", date: "2026-09-01", p: "", balance: -1000 },
    { name: "NOCP-2", party: "A & B Traders", date: "2026-09-01", p: "", balance: -1000 }], async () => {
    const { rows } = await R.loadReceivables("2026-11-05");
    const a = rows.find((r) => r.bill === "NOCP-1");
    assert.equal(a.dueDate, "2026-10-16"); // + Singh's 45-day ledger default
    assert.equal(a.dueDateSource, "ledger default credit period");
    const b = rows.find((r) => r.bill === "NOCP-2"); // ledger has no default either
    assert.equal(b.dueDate, "2026-09-01");
    assert.equal(b.dueDateSource, "bill date (no credit period in Tally)");
  }));

test("a bill with unreadable terms is reported, not fatal", () =>
  withBills([{ name: "ODD-2", party: "Kapoor Builders", date: "2026-09-01", p: "2 Months", balance: -200 }], async () => {
    const { rows } = await R.loadReceivables("2026-11-05");
    const odd = rows.find((r) => r.bill === "ODD-2");
    assert.match(odd.issue, /unrecognised credit period/);
    assert.equal(odd.overdueDays, null);
    assert.equal(odd.dueDate, "");
    assert.equal(rows.at(-1).bill, "ODD-2"); // listed last
  }));

test("getReceivables keeps the original API (open debit bills)", async () => {
  const rows = await R.getReceivables("2026-11-05");
  assert.ok(rows.length > 5 && rows.every((r) => r.outstanding > 0));
});

test("payment history: billed, receipts and credit notes against each bill", async () => {
  const { rows, ledgers } = await R.loadReceivables("2026-11-05");
  const withH = R.attachHistory(rows, await R.getBillHistory(ledgers));
  const by = (b) => withH.find((r) => r.bill === b);
  assert.equal(by("DEMO-002").billed, 94400);
  assert.equal(by("DEMO-002").adjusted, 30000);
  assert.deepEqual(by("DEMO-002").adjustments, [{ date: "2026-08-01", type: "Receipt", number: "DEMO-R02", amount: 30000 }]);
  assert.equal(by("DEMO-002").historyNote, undefined); // 94,400 − 30,000 = 64,400 ✓
  assert.equal(by("DEMO-009").billed, 23600); // item invoice (LEDGERENTRIES.LIST)
  assert.equal(by("DEMO-009").adjustments[0].type, "Credit Note");
  assert.match(by("DEMO-005").historyNote, /vouchers give ₹40000, Tally bill balance is ₹47200/); // mismatch surfaced
  assert.match(by("DEMO-006").historyNote, /no voucher found/);
});
