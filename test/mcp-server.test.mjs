// End-to-end: start the real MCP server (stdio) against the fake Tally and call its tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeTally } from "./fake-tally.mjs";

let tally, tmp, client;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

async function connect(env) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/tally-server.mjs", import.meta.url))],
    env: { ...process.env, TALLY_URL: tally.url, TALLY_COMPANY: "Demo Trading Co",
      DRAFTS_DIR: join(tmp, "drafts"), AUDIT_LOG: join(tmp, "audit.jsonl"), HOLDS_FILE: join(tmp, "holds.json"),
      DOTENV_FILE: join(tmp, "no.env"), GMAIL_TOKEN_FILE: join(tmp, "no-token.json"), REMINDER_DRAFT_DESTINATION: "",
      INVOICE_WRITE_ENABLED: "", INVOICES_DIR: join(tmp, "invoices"), ...env },
    stderr: "ignore",
  }));
  return c;
}

before(async () => {
  tally = await startFakeTally();
  tmp = await mkdtemp(join(tmpdir(), "mcp-test-"));
  await writeFile(join(tmp, "holds.json"), JSON.stringify({ holds: [
    { customer: "Singh Logistics", bill: "DEMO-002", reason: "Route dispute", approvedBy: "Owner", approvedOn: "2026-01-01" }] }));
  client = await connect({ RECEIVABLES_CONFIG: fileURLToPath(new URL("./test-config.json", import.meta.url)) });
});
after(async () => { await client?.close(); await tally.close(); await rm(tmp, { recursive: true, force: true }); });

test("exposes exactly the expected tools; only the draft/invoice tools are not read-only; no send tool", async () => {
  const { tools } = await client.listTools();
  const writers = ["save_reminder_draft", "save_reminder_drafts", "create_retainer_invoices", "save_invoice_drafts"];
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ["create_retainer_invoices", "get_ageing_report", "get_receivables", "list_ledgers", "list_vouchers", "preview_retainer_invoices",
      "save_invoice_drafts", "save_reminder_draft", "save_reminder_drafts", "tally_status"]);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, !writers.includes(t.name), t.name);
  assert.ok(tools.every((t) => !/send|reply|forward/i.test(t.name)));
});

test("Retainer invoices over MCP: preview works; create is refused while writing is switched off", async () => {
  const p = await call("preview_retainer_invoices", {});
  assert.equal(p.data.counts.ready, 3);
  assert.equal(p.data.writeEnabled, false);
  const c = await call("create_retainer_invoices", { approvalCode: p.data.approvalCode });
  assert.equal(c.isError, true);
  assert.match(c.content[0].text, /^No invoices created: Invoice creation is switched off/);
});

test("tally_status", async () => {
  const { data } = await call("tally_status");
  assert.deepEqual(data.openCompanies, ["Demo Trading Co"]);
});

test("get_receivables filters and totals", async () => {
  const { data } = await call("get_receivables", { asOf: "2026-11-05", minOverdueDays: 1 });
  assert.equal(data.asOf, "2026-11-05");
  assert.ok(data.bills.every((b) => b.overdueDays >= 1));
  assert.equal(data.totalOutstanding, data.bills.reduce((s, b) => s + b.outstanding, 0));
  assert.equal(data.billsWithIssues, undefined);

  const ret = await call("get_receivables", { asOf: "2026-11-05", retainerOnly: true });
  assert.deepEqual([...new Set(ret.data.bills.map((b) => b.customer))].sort(), ["Gupta Healthcare", "Sharma Exports Pvt Ltd", "Verma Textiles"]);
});

test("get_receivables: holds, thresholds and per-customer net position", async () => {
  tally.state.bills.push({ name: "SMALL-1", party: "Kapoor Builders", date: "2026-06-01", p: "30 Days", balance: -40 });
  try {
    const { data } = await call("get_receivables", { asOf: "2026-11-05", minOverdueDays: 1 });
    const bills = data.bills.map((b) => b.bill);
    assert.ok(!bills.includes("DEMO-002"), "held bill must not be in bills");
    assert.ok(!bills.includes("SMALL-1"), "bill below threshold must not be in bills");
    assert.deepEqual(data.onHold.map((h) => [h.bill, h.hold]), [["DEMO-002", "Route dispute (approved by Owner on 2026-01-01)"]]);
    assert.deepEqual(data.belowThreshold, { count: 1, total: 40, bills: ["Kapoor Builders / SMALL-1"] });
    assert.deepEqual(data.filters, { minOverdueDays: 1, minAmount: 100 });
    const verma = data.customers.find((c) => c.customer === "Verma Textiles");
    assert.equal(verma.reminder.eligible, false);
    assert.equal(verma.unadjustedCredits, 20000);
    const gupta = data.customers.find((c) => c.customer === "Gupta Healthcare");
    assert.deepEqual(gupta.reminder, { eligible: true, bills: ["DEMO-005"], amount: 47200, netAmount: 44840 });
    assert.equal(data.customers.find((c) => c.customer === "Mehta Retail").reminder.reason, "email missing on the Tally ledger");
    const lower = await call("get_receivables", { asOf: "2026-11-05", minOverdueDays: 1, minAmount: 0 });
    assert.ok(lower.data.bills.some((b) => b.bill === "SMALL-1"));
    const ninety = await call("get_receivables", { asOf: "2026-11-05", minOverdueDays: 90 });
    assert.deepEqual(ninety.data.bills.map((b) => b.bill), ["DEMO-001"]);
  } finally { tally.state.bills.pop(); }
});

test("get_ageing_report: buckets, credits, on account and totals", async () => {
  const { data } = await call("get_ageing_report", { asOf: "2026-11-05" });
  assert.deepEqual(data.bucketLabels, ["Not due", "1-30 days", "31-60 days", "61-90 days", "Over 90 days"]);
  const c = (n) => data.customers.find((x) => x.customer === n);
  assert.equal(c("Kapoor Builders").buckets["Over 90 days"], 59000);
  assert.equal(c("Kapoor Builders").buckets["1-30 days"], 17700);
  assert.equal(c("Singh Logistics").buckets["61-90 days"], 64400);
  assert.equal(c("Singh Logistics").hold, null); // only a bill is held, not the customer
  assert.equal(c("Verma Textiles").netDue, -2300);
  assert.equal(c("Mehta Retail").creditBills, 5000);
  assert.equal(c("Gupta Healthcare").retainer, "yes");
  const t = data.totals;
  assert.equal(Object.values(t.buckets).reduce((s, n) => s + n, 0) + t.unknownDueDate, t.totalBills);
  assert.equal(t.netDue, Math.round((t.totalBills - t.creditBills + t.onAccount) * 100) / 100);
  assert.equal(data.bills, undefined);
  const withPay = await call("get_ageing_report", { asOf: "2026-11-05", includePayments: true, customer: "singh" });
  assert.deepEqual(withPay.data.bills.map((b) => [b.bill, b.billed, b.adjusted]), [["DEMO-002", 94400, 30000]]);
});

test("with the real config, a past asOf is refused with a plain rule message", async () => {
  const strict = await connect({ RECEIVABLES_CONFIG: "" });
  try {
    const r = await strict.callTool({ name: "get_receivables", arguments: { asOf: "2026-01-01" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Ageing as of a past date \(2026-01-01\) is switched off/);
  } finally { await strict.close(); }
});

test("get_receivables always reports bills with issues, even when filtered by days", async () => {
  tally.state.bills.push({ name: "ODD-1", party: "Kapoor Builders", date: "2026-09-01", p: "2 Months", balance: -100 });
  try {
    const { data } = await call("get_receivables", { asOf: "2026-11-05", minOverdueDays: 30, customer: "kapoor" });
    assert.deepEqual(data.bills.map((b) => b.bill), ["DEMO-001"]);
    assert.deepEqual(data.billsWithIssues.map((b) => b.bill), ["ODD-1"]);
  } finally { tally.state.bills.pop(); }
});

test("save_reminder_draft saves; errors come back as tool errors", async () => {
  const ok = await call("save_reminder_draft", {
    customer: "Kapoor Builders", bills: ["DEMO-001"], subject: "Reminder", body: "Invoice DEMO-001 is overdue." });
  assert.equal(ok.data.status, "saved");
  const bad = await call("save_reminder_draft", {
    customer: "Kapoor Builders", bills: ["DEMO-002"], subject: "Reminder", body: "Invoice DEMO-002" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^Draft not saved: Not open receivable bills/);
});

test("save_reminder_drafts: several customers, one result each; Gmail not connected -> not_processed", async () => {
  const local = await call("save_reminder_drafts", { drafts: [
    { customer: "Gupta Healthcare", bills: ["DEMO-005"], subject: "Reminder", body: "Invoice DEMO-005 is overdue." },
    { customer: "Mehta Retail", bills: ["DEMO-004"], subject: "Reminder", body: "Invoice DEMO-004 is overdue." },
  ] });
  assert.equal(local.data.destination, "local");
  assert.deepEqual(local.data.results.map((r) => r.status), ["saved", "rejected"]);
  assert.match(local.data.results[1].reason, /no email in Tally/);
  const gmail = await call("save_reminder_drafts", { destination: "gmail", drafts: [
    { customer: "Kapoor Builders", bills: ["DEMO-009"], subject: "Reminder", body: "Invoice DEMO-009 is overdue." }] });
  assert.equal(gmail.data.results[0].status, "not_processed");
  assert.match(gmail.data.results[0].reason, /Gmail/);
});

test("nothing was ever written to Tally", () => {
  assert.ok(tally.requests.length > 0);
  assert.ok(tally.requests.every((b) => !/Import/i.test(b.match(/<TALLYREQUEST>(.*?)<\/TALLYREQUEST>/)?.[1] ?? "")));
});
