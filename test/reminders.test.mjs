import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeTally } from "./fake-tally.mjs";

const DAY = 86400000;
let tally, tmp, createReminderDraft, readAudit, draftFile, businessDate;

before(async () => {
  tally = await startFakeTally();
  tmp = await mkdtemp(join(tmpdir(), "reminders-test-"));
  Object.assign(process.env, {
    TALLY_URL: tally.url, DRAFTS_DIR: join(tmp, "drafts"), AUDIT_LOG: join(tmp, "logs", "audit.jsonl"),
    REMINDER_COOLDOWN_DAYS: "7",
    RECEIVABLES_CONFIG: fileURLToPath(new URL("./test-config.json", import.meta.url)),
    HOLDS_FILE: join(tmp, "holds.json"),
  });
  ({ createReminderDraft } = await import("../lib/reminders.mjs"));
  ({ readAudit } = await import("../lib/audit.mjs"));
  ({ draftFile } = await import("../lib/drafts.mjs"));
  ({ businessDate } = await import("../lib/dates.mjs"));
});
after(async () => { await tally.close(); await rm(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  await rm(join(tmp, "drafts"), { recursive: true, force: true });
  await rm(join(tmp, "logs"), { recursive: true, force: true });
  await rm(join(tmp, "holds.json"), { force: true });
});

const writeHolds = (holds) => writeFile(join(tmp, "holds.json"), JSON.stringify({ holds }));
const today = () => businessDate(new Date());
async function withBills(extra, fn) {
  const saved = tally.state.bills;
  tally.state.bills = [...saved, ...extra];
  try { return await fn(); } finally { tally.state.bills = saved; }
}

// Audit timestamps are real time, so test "days" are offsets from the real now.
const at = (days) => new Date(Date.now() + days * DAY);
const draft = (customer, bills, extra = {}) => createReminderDraft({
  customer, bills, subject: `Reminder ${bills.join(", ")}`, body: `Dear team,\nInvoice ${bills.join(", ")} is due.\nRegards`, ...extra,
});

test("saves an .eml to the ledger email, never sends, and audits it", async () => {
  const r = await draft("Kapoor Builders", ["DEMO-001"]);
  assert.equal(r.status, "saved");
  assert.equal(r.sent, false);
  assert.equal(r.to, "accounts@kapoor-builders.example.com");
  assert.equal(r.totalDue, 59000);
  assert.equal(r.file, draftFile("Kapoor Builders"));
  const eml = await readFile(r.file, "utf8");
  assert.match(eml, /^To: accounts@kapoor-builders\.example\.com\r\n/);
  assert.match(eml, /\r\nX-Unsent: 1\r\n/);
  const log = await readAudit();
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "saved");
  assert.equal(log[0].body, undefined); // audit must not store email bodies
});

test("customer name is matched case-insensitively to the exact ledger", async () => {
  const r = await draft("kapoor builders", ["DEMO-001"]);
  assert.equal(r.customer, "Kapoor Builders");
});

test("rejections are thrown and audited", async () => {
  await assert.rejects(draft("Nobody Ltd", ["DEMO-001"]), /not found as a ledger/);
  await assert.rejects(draft("Kapoor Builders", ["DEMO-002"]), /Not open receivable bills of "Kapoor Builders".*DEMO-002/);
  await assert.rejects(draft("Sharma Exports Pvt Ltd", ["DEMO-003"]), /Not open/); // fully paid
  await assert.rejects(draft("Mehta Retail", ["DEMO-004"]), /has no email in Tally/);
  await assert.rejects(draft("Kapoor Builders", ["DEMO-001"], { body: "no bill number here" }), /does not mention bill\(s\): DEMO-001/);
  await assert.rejects(draft("Kapoor Builders", ["DEMO-001"], { subject: "x\r\nBcc: evil@example.com" }), /Line breaks/);
  const statuses = (await readAudit()).map((e) => e.status);
  assert.deepEqual(statuses, ["rejected", "rejected", "rejected", "rejected", "rejected", "error"]);
  assert.deepEqual(await readdir(tmp).then((d) => d.includes("drafts")), false); // nothing saved
});

test("invalid ledger email is rejected", async () => {
  const l = tally.state.ledgers.find((x) => x.name === "Singh Logistics");
  const saved = l.email;
  l.email = "ap@singh, not-an-email";
  try {
    await assert.rejects(draft("Singh Logistics", ["DEMO-002"]), /invalid email/);
  } finally { l.email = saved; }
});

test("a bill whose due date can't be worked out is rejected", async () => {
  const saved = tally.state.bills;
  tally.state.bills = [...saved, { name: "ODD-1", party: "Kapoor Builders", date: "2026-09-01", p: "2 Months", balance: -100 }];
  try {
    await assert.rejects(draft("Kapoor Builders", ["ODD-1"]), /cannot be aged.*ODD-1/);
  } finally { tally.state.bills = saved; }
});

test("same bill within the cooldown is skipped as a duplicate", async () => {
  await draft("Kapoor Builders", ["DEMO-001"]);
  const r = await draft("Kapoor Builders", ["DEMO-001", "DEMO-009"], { now: at(2) });
  assert.equal(r.status, "skipped_duplicate");
  assert.deepEqual(r.duplicates.map((d) => [d.bill, d.source]), [["DEMO-001", "audit log"]]);
  assert.equal((await readAudit()).at(-1).status, "skipped_duplicate");
});

test("after the cooldown the bill can be drafted again", async () => {
  await draft("Kapoor Builders", ["DEMO-001"]);
  const r = await draft("Kapoor Builders", ["DEMO-001"], { now: at(8) });
  assert.equal(r.status, "saved");
});

test("same bill number of a DIFFERENT customer is not a duplicate", async () => {
  assert.equal((await draft("A & B Traders", ["1"])).status, "saved");
  const r = await draft("A-B Traders", ["1"], { now: at(1) });
  assert.equal(r.status, "saved");
});

test("same customer, same day: refresh is allowed and reports dropped bills", async () => {
  await draft("Kapoor Builders", ["DEMO-001", "DEMO-009"]);
  const r = await draft("Kapoor Builders", ["DEMO-009"]);
  assert.equal(r.status, "saved");
  assert.equal(r.replacedTodaysDraft, true);
  assert.deepEqual(r.droppedBills, ["DEMO-001"]);
});

test("an overwritten draft no longer blocks the bills it used to contain", async () => {
  await draft("Kapoor Builders", ["DEMO-001", "DEMO-009"]);
  await draft("Kapoor Builders", ["DEMO-009"]); // same day: DEMO-001 is no longer in any draft
  const r = await draft("Kapoor Builders", ["DEMO-001"], { now: at(1) });
  assert.equal(r.status, "saved");
  const r2 = await draft("Kapoor Builders", ["DEMO-009"], { now: at(1) });
  assert.equal(r2.status, "skipped_duplicate");
});

test("an earlier draft FILE with no audit line still counts as a duplicate", async () => {
  const file = draftFile("Gupta Healthcare", at(-2));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "To: finance@gupta-health.example.com\r\nSubject: x\r\n\r\nBill No.: DEMO-005\r\n");
  const r = await draft("Gupta Healthcare", ["DEMO-005"]);
  assert.equal(r.status, "skipped_duplicate");
  assert.deepEqual(r.duplicates, [{ bill: "DEMO-005", draftedOn: businessDate(at(-2)), file, source: "draft file" }]);
});

test("draft-file check matches whole bill numbers only", async () => {
  const file = draftFile("Kapoor Builders", at(-1));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "To: x@example.com\r\nSubject: DEMO-001\r\n\r\nInvoice DEMO-0011 only\r\n"); // header & longer no.
  assert.equal((await draft("Kapoor Builders", ["DEMO-001"])).status, "saved");
});

test("never overwrites another customer's draft that maps to the same file name", async () => {
  await draft("A & B Traders", ["1"]);
  await assert.rejects(draft("A-B Traders", ["1"]), /share the draft file name/);
});

test("draft folder uses the India date", async () => {
  const now = new Date("2026-11-05T20:00:00Z"); // 01:30 IST on 6 Nov
  const r = await draft("Kapoor Builders", ["DEMO-001"], { now });
  assert.equal(r.file, join(process.env.DRAFTS_DIR, "2026-11-06", "kapoor-builders.eml"));
  assert.equal(r.bills[0].overdueDays, 128); // aged as of 6 Nov IST, not 5 Nov UTC
});

test("same file name on an earlier day, but another customer's (per audit) is not a duplicate", async () => {
  await draft("A & B Traders", ["1"]);
  assert.equal((await draft("A-B Traders", ["1"], { now: at(1) })).status, "saved");
  // ...while the real owner of that file is still protected
  assert.equal((await draft("A & B Traders", ["1"], { now: at(2) })).status, "skipped_duplicate");
});

// --- Rules added with the ageing work (docs/ACCOUNTING_RULES.md §5–§9) ---

test("advances/credits are reported with the saved draft", async () => {
  const r = await draft("Gupta Healthcare", ["DEMO-005"]);
  assert.equal(r.status, "saved");
  assert.equal(r.unadjustedCredits, 2360); // credit note CN-GUPTA-01
  assert.equal(r.netOverdue, 44840);
  assert.equal((await readAudit()).at(-1).netOverdue, 44840);
});

test("no reminder when unadjusted credits cover the overdue amount", async () => {
  await assert.rejects(draft("Verma Textiles", ["DEMO-007"]),
    /No reminder for "Verma Textiles": unadjusted advances\/credits ₹20000 cover the overdue ₹17700/);
});

test("customer on hold: rejected; expired hold: allowed", async () => {
  await writeHolds([{ customer: "kapoor builders", reason: "Dispute on site work", approvedBy: "Owner", approvedOn: "2026-01-01" }]);
  await assert.rejects(draft("Kapoor Builders", ["DEMO-001"]), /On hold — no reminder allowed: DEMO-001: Dispute on site work/);
  await writeHolds([{ customer: "Kapoor Builders", reason: "Old", approvedBy: "Owner", approvedOn: "2026-01-01", until: "2026-01-31" }]);
  assert.equal((await draft("Kapoor Builders", ["DEMO-001"])).status, "saved");
});

test("bill on hold: only that bill is blocked", async () => {
  await writeHolds([{ customer: "Kapoor Builders", bill: "DEMO-009", reason: "Rate query", approvedBy: "Owner", approvedOn: today() }]);
  await assert.rejects(draft("Kapoor Builders", ["DEMO-001", "DEMO-009"]), /DEMO-009: Rate query/);
  assert.equal((await draft("Kapoor Builders", ["DEMO-001"])).status, "saved");
});

test("a broken holds file blocks drafting (never silently ignored)", async () => {
  await writeFile(join(tmp, "holds.json"), JSON.stringify({ holds: [{ customer: "Kapoor Builders" }] }));
  await assert.rejects(draft("Kapoor Builders", ["DEMO-001"]), /holds\.json is invalid/);
});

test("bills not yet overdue, or below the threshold, are rejected", () =>
  withBills([
    { name: "FUT-1", party: "Kapoor Builders", date: businessDate(at(-5)), p: "30 Days", balance: -5000 },
    { name: "SMALL-1", party: "Kapoor Builders", date: "2026-06-01", p: "30 Days", balance: -99 },
  ], async () => {
    await assert.rejects(draft("Kapoor Builders", ["FUT-1"]), /Not overdue yet: FUT-1 \(due /);
    await assert.rejects(draft("Kapoor Builders", ["SMALL-1"]), /below the ₹100 reminder threshold: SMALL-1/);
  }));

test("several emails on the ledger: all used, duplicates removed", async () => {
  const l = tally.state.ledgers.find((x) => x.name === "Singh Logistics");
  const saved = l.email;
  l.email = "ap@singh.example.com; accounts@singh.example.com, AP@singh.example.com";
  try {
    assert.equal((await draft("Singh Logistics", ["DEMO-002"])).to, "ap@singh.example.com, accounts@singh.example.com");
  } finally { l.email = saved; }
});
