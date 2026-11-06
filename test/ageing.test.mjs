// Unit tests for the pure calculation rules (docs/ACCOUNTING_RULES.md). No Tally needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDueDate, overdueDays, daysBetween, bucketLabels, bucketOf, checkAsOf, customerPosition, buildAgeingReport,
} from "../lib/ageing.mjs";
import { validateConfig } from "../lib/config.mjs";
import { fmtDate } from "../lib/dates.mjs";

const d = (s) => new Date(s);
const cfg = { ageingBuckets: [30, 60, 90], minBillBalance: 100, minCustomerNetOverdue: 0, dueDateFallback: "ledger-default" };
const row = (bill, overdue, outstanding, extra = {}) =>
  ({ bill, customer: "C", overdueDays: overdue, outstanding, dueDateSource: "bill credit period", ...extra });

// --- §2 due date source ---
test("due date: the bill's own credit period wins over the ledger default", () => {
  const r = resolveDueDate({ billDate: d("2026-06-01"), creditDays: 30 }, 45);
  assert.equal(fmtDate(r.dueDate), "2026-07-01");
  assert.equal(r.source, "bill credit period");
});

test("due date: a fixed due date on the bill is used as-is", () => {
  const r = resolveDueDate({ billDate: d("2026-06-01"), fixedDue: d("2026-08-15") }, 45);
  assert.equal(fmtDate(r.dueDate), "2026-08-15");
  assert.equal(r.source, "bill due date");
});

test("due date: no credit period on the bill -> ledger default (flagged)", () => {
  const r = resolveDueDate({ billDate: d("2026-06-01"), creditDays: null }, 45);
  assert.equal(fmtDate(r.dueDate), "2026-07-16");
  assert.equal(r.source, "ledger default credit period");
});

test("due date: no credit period anywhere -> bill date, clearly labelled (Tally's own behaviour)", () => {
  const r = resolveDueDate({ billDate: d("2026-06-01"), creditDays: null }, null);
  assert.equal(fmtDate(r.dueDate), "2026-06-01");
  assert.equal(r.source, "bill date (no credit period in Tally)");
});

test("due date: fallback settings", () => {
  const terms = { billDate: d("2026-06-01"), creditDays: null };
  assert.equal(resolveDueDate(terms, 45, "bill-date").source, "bill date (no credit period in Tally)");
  assert.match(resolveDueDate(terms, 45, "none").issue, /no credit period on the bill/);
  assert.equal(fmtDate(resolveDueDate({ billDate: d("2026-06-01"), creditDays: 0 }, 45).dueDate), "2026-06-01"); // explicit 0 days
});

test("due date: missing bill date or bad terms -> issue, never a guess", () => {
  assert.match(resolveDueDate({ billDate: null, creditDays: 30 }, 30).issue, /no bill date/);
  assert.match(resolveDueDate({ issue: "unrecognised credit period" }, 30).issue, /unrecognised/);
});

// --- §3 overdue days ---
test("overdue days: due today = 0, day after = 1, not yet due = 0", () => {
  assert.equal(overdueDays(d("2026-07-01"), d("2026-07-01")), 0);
  assert.equal(overdueDays(d("2026-07-02"), d("2026-07-01")), 1);
  assert.equal(overdueDays(d("2026-06-20"), d("2026-07-01")), 0);
  assert.equal(overdueDays(d("2026-11-05"), d("2026-07-01")), 127);
  assert.equal(daysBetween(d("2026-06-01"), d("2026-11-05")), 157); // days since bill date
});

test("overdue days across a leap day", () => {
  assert.equal(overdueDays(d("2028-03-01"), d("2028-02-28")), 2);
});

test("asOf policy: past dates refused unless enabled", () => {
  assert.throws(() => checkAsOf("2026-11-05", "2026-11-06", false), (e) => e.rule && /past date/.test(e.message));
  assert.doesNotThrow(() => checkAsOf("2026-11-06", "2026-11-06", false));
  assert.doesNotThrow(() => checkAsOf("2026-12-31", "2026-11-06", false)); // future: "what will be overdue"
  assert.doesNotThrow(() => checkAsOf("2026-11-05", "2026-11-06", true));
});

// --- §4 buckets ---
test("bucket labels and boundaries for [30, 60, 90]", () => {
  assert.deepEqual(bucketLabels([30, 60, 90]), ["Not due", "1-30 days", "31-60 days", "61-90 days", "Over 90 days"]);
  const b = (n) => bucketOf(n, [30, 60, 90]);
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91, 400].map(b),
    ["Not due", "1-30 days", "1-30 days", "31-60 days", "31-60 days", "61-90 days", "61-90 days", "Over 90 days", "Over 90 days"]);
});

test("custom buckets", () => {
  assert.deepEqual(bucketLabels([15, 45]), ["Not due", "1-15 days", "16-45 days", "Over 45 days"]);
  assert.equal(bucketOf(16, [15, 45]), "16-45 days");
});

// --- §5–§9 customer position ---
test("position: buckets, totals and a simple eligible reminder", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", 100, 1000), row("B2", 45, 500), row("B3", 0, 300)] });
  assert.deepEqual(p.buckets, { "Not due": 300, "1-30 days": 0, "31-60 days": 500, "61-90 days": 0, "Over 90 days": 1000 });
  assert.equal(p.totalBills, 1800);
  assert.equal(p.overdueTotal, 1500);
  assert.equal(p.oldestOverdueDays, 100);
  assert.deepEqual(p.reminder, { eligible: true, bills: ["B1", "B2"], amount: 1500, netAmount: 1500 });
});

test("position: advances/credit notes are set off against overdue (net)", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", 40, 10000)], credits: [{ bill: "ADV", amount: 2500 }] });
  assert.equal(p.creditBills, 2500);
  assert.equal(p.unadjustedCredits, 2500);
  assert.equal(p.netOverdue, 7500);
  assert.equal(p.netDue, 7500);
  assert.deepEqual(p.reminder, { eligible: true, bills: ["B1"], amount: 10000, netAmount: 7500 });
});

test("position: credits covering the overdue amount -> no reminder", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", 40, 17700)], onAccount: -20000 });
  assert.equal(p.unadjustedCredits, 20000);
  assert.equal(p.netDue, -2300); // customer is in credit
  assert.equal(p.reminder.eligible, false);
  assert.match(p.reminder.reason, /unadjusted advances\/credits ₹20000 cover the overdue ₹17700/);
});

test("position: exactly equal credits -> no reminder (net must be > 0)", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", 40, 5000)], credits: [{ bill: "CN", amount: 5000 }] });
  assert.equal(p.reminder.eligible, false);
});

test("position: on-account DEBIT is not a credit, but is part of net due", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg, rows: [row("B1", 40, 1000)], onAccount: 400 });
  assert.equal(p.unadjustedCredits, 0);
  assert.equal(p.netDue, 1400);
  assert.equal(p.netOverdue, 1000);
});

test("position: bills below the threshold are not chased", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg, rows: [row("B1", 40, 99.5), row("B2", 40, 100)] });
  assert.deepEqual(p.reminder.bills, ["B2"]); // 100 is at the threshold: allowed
  const only = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg, rows: [row("B1", 40, 50)] });
  assert.match(only.reminder.reason, /no overdue bill qualifies/);
  assert.equal(only.overdueTotal, 50); // still reported
});

test("position: holds — whole customer and single bill", () => {
  const holds = [{ customer: "c", reason: "Dispute", approvedBy: "Owner", approvedOn: "2026-11-01" }];
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg, rows: [row("B1", 40, 1000)], holds });
  assert.match(p.hold, /Dispute \(approved by Owner on 2026-11-01\)/);
  assert.match(p.reminder.reason, /^on hold: Dispute/);

  const billHold = [{ customer: "C", bill: "B1", reason: "Wrong rate", approvedBy: "Owner", approvedOn: "2026-11-01" }];
  const q = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", 40, 1000), row("B2", 40, 700)], holds: billHold });
  assert.equal(q.hold, null);
  assert.deepEqual(q.reminder.bills, ["B2"]);
});

test("position: email missing / invalid blocks the reminder", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "" }, config: cfg, rows: [row("B1", 40, 1000)] });
  assert.equal(p.emailStatus, "missing");
  assert.match(p.reminder.reason, /email missing/);
  const q = customerPosition({ customer: "C", ledger: { email: "a@b.com; bad" }, config: cfg, rows: [row("B1", 40, 1000)] });
  assert.equal(q.emailStatus, "invalid");
  assert.deepEqual(q.invalidEmails, ["bad"]);
});

test("position: bills with unknown due date are kept apart", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg,
    rows: [row("B1", null, 900, { issue: "x" }), row("B2", 0, 100)] });
  assert.equal(p.unknownDueDate, 900);
  assert.equal(p.overdueTotal, 0);
  assert.equal(p.totalBills, 1000);
  assert.equal(p.reminder.reason, "nothing overdue");
});

test("position: paise are rounded, not floating-point noise", () => {
  const p = customerPosition({ customer: "C", ledger: { email: "a@b.com" }, config: cfg, rows: [row("B1", 5, 0.1), row("B2", 5, 0.2)] });
  assert.equal(p.totalBills, 0.3);
});

// --- §10 report ---
test("ageing report: totals add up and warnings are raised", () => {
  const rows = [
    { ...row("B1", 100, 1000), customer: "X" },
    { ...row("B2", 10, 500), customer: "Y", dueDateSource: "ledger default credit period" },
    { ...row("B3", null, 50, { issue: "bad P" }), customer: "Y" },
  ];
  const ledgers = new Map([["X", { email: "x@x.com" }], ["Y", { email: "" }], ["Z", { email: "z@z.com" }]]);
  const r = buildAgeingReport({ asOf: d("2026-11-05"), ledgers, rows, config: cfg, holds: [],
    credits: [{ bill: "ADV", customer: "Z", amount: 300 }], onAccount: new Map([["X", 200]]) });
  assert.equal(r.asOf, "2026-11-05");
  assert.deepEqual(r.customers.map((c) => c.customer), ["X", "Y", "Z"]);
  assert.equal(r.totals.totalBills, 1550);
  assert.equal(r.totals.unknownDueDate, 50);
  assert.equal(Object.values(r.totals.buckets).reduce((s, n) => s + n, 0), 1500);
  assert.equal(r.totals.creditBills, 300);
  assert.equal(r.totals.netDue, 1550 - 300 + 200);
  assert.ok(r.warnings.some((w) => /B3: bad P/.test(w)));
  assert.ok(r.warnings.some((w) => /B2: due date from ledger default/.test(w)));
  assert.ok(r.warnings.some((w) => /X: ₹200 .* no bill reference/.test(w)));
  assert.ok(r.warnings.some((w) => /Y: email missing/.test(w)));
});

test("config validation rejects unsafe values", () => {
  const ok = { debtorsGroup: "Sundry Debtors", retainerGroup: "Retainer Customers", ageingBuckets: [30, 60, 90],
    dueDateFallback: "ledger-default", minBillBalance: 100, minCustomerNetOverdue: 0, allowPastAsOf: false, holdsFile: "h.json" };
  assert.doesNotThrow(() => validateConfig({ ...ok }));
  assert.throws(() => validateConfig({ ...ok, ageingBuckets: [60, 30] }), /ageingBuckets/);
  assert.throws(() => validateConfig({ ...ok, dueDateFallback: "guess" }), /dueDateFallback/);
  assert.throws(() => validateConfig({ ...ok, minBillBalance: -1 }), /minBillBalance/);
  assert.throws(() => validateConfig({ ...ok, allowPastAsOf: "yes" }), /allowPastAsOf/);
});
