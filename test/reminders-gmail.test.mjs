// Reminder workflow -> Gmail drafts, against a fake Tally and a fake Google. No real Gmail is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeTally } from "./fake-tally.mjs";
import { startFakeGoogle } from "./fake-google.mjs";

const DAY = 86400000;
const INSERT = "https://www.googleapis.com/auth/gmail.insert";
let tally, g, tmp, R, readAudit, oauth;

before(async () => {
  tally = await startFakeTally();
  g = await startFakeGoogle();
  tmp = await mkdtemp(join(tmpdir(), "reminders-gmail-"));
  Object.assign(process.env, {
    TALLY_URL: tally.url, DRAFTS_DIR: join(tmp, "drafts"), AUDIT_LOG: join(tmp, "logs", "audit.jsonl"),
    REMINDER_COOLDOWN_DAYS: "7", RECEIVABLES_CONFIG: fileURLToPath(new URL("./test-config.json", import.meta.url)),
    HOLDS_FILE: join(tmp, "holds.json"), DOTENV_FILE: join(tmp, "no.env"),
    GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GMAIL_SCOPE: "insert",
    GMAIL_TOKEN_FILE: join(tmp, "tok", "gmail-token.json"),
    GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: g.url,
  });
  R = await import("../lib/reminders.mjs");
  ({ readAudit } = await import("../lib/audit.mjs"));
  oauth = await import("../lib/gmail/oauth.mjs");
});
after(async () => { await tally.close(); await g.close(); await rm(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  for (const d of ["drafts", "logs", "holds.json"]) await rm(join(tmp, d), { recursive: true, force: true });
  Object.assign(g.state, { requests: [], refreshError: null, gmailStatus: 200, drafts: [], grantedScope: `${INSERT} openid` });
  oauth.invalidateAccessToken();
  await mkdir(join(tmp, "tok"), { recursive: true });
  await writeFile(process.env.GMAIL_TOKEN_FILE, JSON.stringify({ refresh_token: "r", scope: `${INSERT} openid`,
    gmail_scope: INSERT, client_id: "test-client", account: "me@example.com" }));
});

const at = (days) => new Date(Date.now() + days * DAY);
const body = (bills) => `Dear team,\n\nInvoice ${bills[0]} | Dated 01-Jun-2026 | Due 01-Jul-2026 | Balance ₹59,000\n` +
  `${bills.slice(1).map((b) => `Invoice ${b} | Dated 02-Oct-2026 | Due 01-Nov-2026 | Balance ₹23,600\n`).join("")}\nRegards,\nAccounts Team`;
const item = (customer, bills) => ({ customer, bills, subject: `Payment reminder: Invoice ${bills.join(", ")} – due`, body: body(bills) });
const gmailDraft = (customer, bills, extra = {}) => R.createReminderDraft({ ...item(customer, bills), destination: "gmail", ...extra });
const gmailCalls = () => g.state.requests.filter((q) => q.path.startsWith("/gmail/")).length;

test("gmail destination: Gmail draft only (no local file), recipient from Tally, ids returned, never sent", async () => {
  const r = await gmailDraft("Kapoor Builders", ["DEMO-001"]);
  assert.equal(r.status, "saved");
  assert.equal(r.sent, false);
  assert.equal(r.destination, "gmail");
  assert.deepEqual(r.gmail, { messageId: "m-d1", draftId: null, threadId: "t-d1", mode: "insert", account: "me@example.com" });
  assert.equal(r.file, undefined);
  await assert.rejects(readFile(join(tmp, "drafts"), "utf8"), "no local drafts folder is created");
  const raw = g.state.drafts[0].raw;
  assert.match(raw, /^To: accounts@kapoor-builders\.example\.com\r\n/);
  assert.deepEqual(g.state.drafts[0].labelIds, ["DRAFT"]);
  assert.equal(g.state.requests.filter((q) => /send/i.test(q.path)).length, 0);
  const log = await readAudit();
  assert.deepEqual(log.map((e) => e.status), ["gmail_pending", "saved"]);
  assert.equal(log[1].gmail.messageId, "m-d1");
  assert.equal(log[1].attemptId, log[0].attemptId);
  assert.ok(log.every((e) => e.body === undefined), "audit never stores the email body");
});

test("HTML body: the bill lines arrive as a table, text part unchanged", async () => {
  await gmailDraft("Kapoor Builders", ["DEMO-001", "DEMO-009"]);
  const parts = [...g.state.drafts[0].raw.matchAll(/Content-Type: (text\/\w+)[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)]
    .map(([, t, b]) => [t, Buffer.from(b.replace(/\r\n/g, ""), "base64").toString("utf8")]);
  const html = parts.find(([t]) => t === "text/html")[1];
  assert.match(html, /<table[^>]*><tr><td[^>]*>Invoice DEMO-001<\/td>.*<td[^>]*>Balance ₹59,000<\/td><\/tr><tr><td[^>]*>Invoice DEMO-009/);
  assert.equal(parts.find(([t]) => t === "text/plain")[1], body(["DEMO-001", "DEMO-009"]).replace(/\n/g, "\r\n"));
});

test("missing / invalid customer email: rejected before any Gmail call", async () => {
  await assert.rejects(gmailDraft("Mehta Retail", ["DEMO-004"]), /has no email in Tally/);
  const l = tally.state.ledgers.find((x) => x.name === "Singh Logistics");
  const keep = l.email;
  l.email = "ap@singh";
  try { await assert.rejects(gmailDraft("Singh Logistics", ["DEMO-002"]), /invalid email/); } finally { l.email = keep; }
  assert.equal(gmailCalls(), 0);
});

test("Gmail API failure: status error, no local file, and a later retry is allowed", async () => {
  g.state.gmailStatus = 503;
  await assert.rejects(gmailDraft("Kapoor Builders", ["DEMO-001"]), (e) => e.draftStatus === "error" && /Gmail API error 503/.test(e.message));
  const log = await readAudit();
  assert.deepEqual(log.map((e) => e.status), ["gmail_pending", "error"]);
  assert.equal(log[1].attemptId, log[0].attemptId, "the pending attempt is closed by the error line");
  await assert.rejects(readFile(join(tmp, "drafts"), "utf8"));
  g.state.gmailStatus = 200;
  assert.equal((await gmailDraft("Kapoor Builders", ["DEMO-001"])).status, "saved");
});

test("duplicate: same bill already in a Gmail draft today -> skipped, no second Gmail draft (any destination)", async () => {
  await gmailDraft("Kapoor Builders", ["DEMO-001"]);
  const again = await gmailDraft("Kapoor Builders", ["DEMO-001", "DEMO-009"]);
  assert.equal(again.status, "skipped_duplicate");
  assert.deepEqual(again.duplicates.map((d) => [d.bill, d.source, d.gmailMessageId]), [["DEMO-001", "gmail draft (today)", "m-d1"]]);
  const local = await R.createReminderDraft({ ...item("Kapoor Builders", ["DEMO-001"]), destination: "local" });
  assert.equal(local.status, "skipped_duplicate");
  assert.equal(gmailCalls(), 1);
});

test("duplicate: a Gmail draft keeps blocking within the cooldown, even after today's local file is overwritten", async () => {
  await gmailDraft("Kapoor Builders", ["DEMO-001"]);
  const other = await R.createReminderDraft({ ...item("Kapoor Builders", ["DEMO-009"]), destination: "local" }); // overwrites local file
  assert.equal(other.status, "saved");
  assert.equal(other.replacedTodaysDraft, undefined, "a Gmail draft's local copy is not reported as replaced");
  const tomorrow = await gmailDraft("Kapoor Builders", ["DEMO-001"], { now: at(1) });
  assert.equal(tomorrow.status, "skipped_duplicate");
  assert.equal(tomorrow.duplicates[0].source, "gmail draft");
  assert.equal((await gmailDraft("Kapoor Builders", ["DEMO-001"], { now: at(8) })).status, "saved", "allowed after the cooldown");
});

test("duplicate: an unfinished Gmail attempt (crash mid-call) blocks the bill and asks to check Gmail", async () => {
  await mkdir(dirname(process.env.AUDIT_LOG), { recursive: true });
  await appendFile(process.env.AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), action: "reminder_draft",
    customer: "Kapoor Builders", bills: ["DEMO-001"], status: "gmail_pending", attemptId: "x1" }) + "\n");
  const r = await gmailDraft("Kapoor Builders", ["DEMO-001"]);
  assert.equal(r.status, "skipped_duplicate");
  assert.equal(r.duplicates[0].source, "unconfirmed gmail attempt");
  assert.match(r.message, /check Gmail Drafts/);
  assert.equal(gmailCalls(), 0);
});

test("batch: several customers in one run, per-item status, one run id, failures don't stop the run", async () => {
  const r = await R.createReminderDrafts({ destination: "gmail", drafts: [
    item("Kapoor Builders", ["DEMO-001"]),
    item("Mehta Retail", ["DEMO-004"]), // no email
    item("Gupta Healthcare", ["DEMO-005"]),
    item("kapoor builders", ["DEMO-009"]), // same customer twice in this run
    item("Kapoor Builders", ["DEMO-002"]), // not this customer's bill... but skipped first as duplicate-in-run
  ] });
  assert.match(r.runId, /^run-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  assert.equal(r.sent, false);
  assert.deepEqual(r.results.map((x) => x.status), ["saved", "rejected", "saved", "skipped_duplicate", "skipped_duplicate"]);
  assert.deepEqual(r.counts, { saved: 2, rejected: 1, skipped_duplicate: 2 });
  assert.equal(r.results[0].gmailMessageId, "m-d1");
  assert.equal(r.results[2].gmailMessageId, "m-d2");
  assert.match(r.results[1].reason, /no email in Tally/);
  assert.equal(g.state.drafts.length, 2);
  assert.ok((await readAudit()).filter((e) => e.status !== "gmail_pending").every((e) => e.runId === r.runId));
});

test("batch: expired Gmail login -> nothing attempted, every item not_processed with the re-login hint", async () => {
  g.state.refreshError = "invalid_grant";
  const r = await R.createReminderDrafts({ destination: "gmail", drafts: [item("Kapoor Builders", ["DEMO-001"]), item("Gupta Healthcare", ["DEMO-005"])] });
  assert.deepEqual(r.results.map((x) => x.status), ["not_processed", "not_processed"]);
  assert.match(r.results[0].reason, /npm run gmail:auth/);
  assert.equal(gmailCalls(), 0);
  assert.equal((await readAudit()).length, 2);
});

test("batch: Gmail not connected at all -> not_processed; local destination still works", async () => {
  await rm(process.env.GMAIL_TOKEN_FILE);
  const r = await R.createReminderDrafts({ destination: "gmail", drafts: [item("Kapoor Builders", ["DEMO-001"])] });
  assert.equal(r.results[0].status, "not_processed");
  assert.match(r.results[0].reason, /not connected/);
  const local = await R.createReminderDrafts({ drafts: [item("Kapoor Builders", ["DEMO-001"])] });
  assert.equal(local.destination, "local");
  assert.equal(local.results[0].status, "saved");
  assert.equal(local.results[0].gmailMessageId, undefined);
});

test("destination is validated", async () => {
  await assert.rejects(R.createReminderDraft({ ...item("Kapoor Builders", ["DEMO-001"]), destination: "smtp" }), /must be "local" or "gmail"/);
  await assert.rejects(R.createReminderDrafts({ destination: "send", drafts: [item("Kapoor Builders", ["DEMO-001"])] }), /must be "local" or "gmail"/);
});
