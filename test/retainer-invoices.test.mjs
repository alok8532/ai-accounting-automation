// Retainer invoice workflow against a fake Tally (with import support) and a fake Google.
// No real Tally, no real Gmail, no Edge (the PDF renderer is replaced).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeTally, demoState } from "./fake-tally.mjs";
import { startFakeGoogle } from "./fake-google.mjs";

const INSERT = "https://www.googleapis.com/auth/gmail.insert";
const REAL_CONFIG = JSON.parse(await readFile(new URL("../config/retainer-billing.json", import.meta.url), "utf8"));
let tally, g, tmp, R, readAudit, pdfMod, businessDate, cfgFile;

before(async () => {
  tally = await startFakeTally({ allowImport: true });
  g = await startFakeGoogle();
  tmp = await mkdtemp(join(tmpdir(), "retainer-test-"));
  cfgFile = join(tmp, "retainer-billing.json");
  Object.assign(process.env, {
    TALLY_URL: tally.url, DRAFTS_DIR: join(tmp, "drafts"), AUDIT_LOG: join(tmp, "logs", "audit.jsonl"),
    INVOICES_DIR: join(tmp, "invoices"), RETAINER_BILLING_CONFIG: cfgFile,
    RECEIVABLES_CONFIG: fileURLToPath(new URL("./test-config.json", import.meta.url)),
    HOLDS_FILE: join(tmp, "holds.json"), DOTENV_FILE: join(tmp, "no.env"),
    GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GMAIL_SCOPE: "insert",
    GMAIL_TOKEN_FILE: join(tmp, "tok", "gmail-token.json"),
    GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: g.url,
  });
  R = await import("../lib/retainer-invoices.mjs");
  ({ readAudit } = await import("../lib/audit.mjs"));
  ({ businessDate } = await import("../lib/dates.mjs"));
  pdfMod = await import("../lib/invoice-pdf.mjs");
  pdfMod.renderer.htmlToPdf = async (htmlFile, pdfFile) =>
    writeFile(pdfFile, Buffer.concat([Buffer.from("%PDF-1.4 fake\n"), await readFile(htmlFile)]));
});
after(async () => { await tally.close(); await g.close(); await rm(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  const fresh = demoState();
  for (const k of ["ledgers", "bills", "vouchers", "groups"]) tally.state[k] = fresh[k];
  Object.assign(tally.state, { importMode: "ok", imports: [], nextVoucherNumber: 21, nextMasterId: 100 });
  tally.requests.length = 0;
  Object.assign(g.state, { requests: [], refreshError: null, gmailStatus: 200, drafts: [], grantedScope: `${INSERT} openid` });
  for (const d of ["drafts", "logs", "invoices", "tok"]) await rm(join(tmp, d), { recursive: true, force: true });
  await writeConfig();
  process.env.INVOICE_WRITE_ENABLED = "true";
  (await import("../lib/gmail/oauth.mjs")).invalidateAccessToken();
});

const writeConfig = (change = (c) => c) => writeFile(cfgFile, JSON.stringify(change(structuredClone(REAL_CONFIG))));
const period = () => businessDate().slice(0, 7);
const preview = () => R.previewRetainerInvoices();
const create = async (extra = {}) => R.createRetainerInvoices({ approvalCode: (await preview()).approvalCode, ...extra });
const tallyWrites = () => tally.requests.filter((b) => /<TALLYREQUEST>\s*Import/i.test(b));
const connectGmail = async () => {
  await mkdir(join(tmp, "tok"), { recursive: true });
  await writeFile(process.env.GMAIL_TOKEN_FILE, JSON.stringify({ refresh_token: "r", scope: `${INSERT} openid`,
    gmail_scope: INSERT, client_id: "test-client", account: "me@example.com" }));
};

// ---------- preview (read-only) ----------

test("preview: Retainer customers from the Tally group, amounts, GST, due dates from ledger credit days", async () => {
  const p = await preview();
  const writesBefore = tallyWrites().length;
  assert.equal(p.period, period());
  assert.equal(p.invoiceDate, `${period()}-01`);
  assert.deepEqual(p.counts, { ready: 3, already_invoiced: 0, blocked: 0, needs_setup: 0 });
  const sharma = p.rows.find((r) => r.customer === "Sharma Exports Pvt Ltd");
  assert.deepEqual([sharma.fee, sharma.cgst, sharma.sgst, sharma.total, sharma.creditDays], [25000, 2250, 2250, 29500, 15]);
  assert.equal(sharma.billRef, `RET/${period()}/SHARMA`);
  assert.equal(sharma.to, "accounts@sharma-exports.example.com");
  assert.equal(sharma.dueDate, new Date(Date.parse(`${period()}-01`) + 15 * 86400000).toISOString().slice(0, 10));
  assert.ok(p.rows.find((r) => r.customer === "Gupta Healthcare"), "nested Retainer sub-group is included");
  assert.ok(!p.rows.some((r) => r.customer === "Kapoor Builders"), "non-Retainer customers are not billed");
  assert.deepEqual(p.totals, { fee: 80000, gst: 14400, total: 94400 });
  assert.match(p.approvalCode, /^INV-[0-9A-F]{8}$/);
  assert.equal((await preview()).approvalCode, p.approvalCode, "same data -> same code");
  assert.equal(tallyWrites().length, writesBefore, "preview never writes");
});

test("preview flags, never guesses: no terms -> needs_setup; missing ledger / credit period -> blocked", async () => {
  tally.state.ledgers.push({ name: "New Retainer Co", parent: "Retainer Customers", email: "a@new.example.com", credit: 30 });
  tally.state.ledgers.find((l) => l.name === "Verma Textiles").credit = undefined;
  await writeConfig((c) => { c.customers["Gupta Healthcare"].incomeLedger = "Retainer Income"; return c; });
  const p = await preview();
  const by = (n) => p.rows.find((r) => r.customer === n);
  assert.equal(by("New Retainer Co").status, "needs_setup");
  assert.equal(by("Gupta Healthcare").status, "blocked");
  assert.match(by("Gupta Healthcare").issues[0], /Ledger "Retainer Income" does not exist/);
  assert.equal(by("Verma Textiles").status, "blocked");
  assert.match(by("Verma Textiles").issues.join(), /no default credit period/);
  assert.equal(p.counts.ready, 1);
});

test("preview: configured customer outside the Retainer group is ignored with a warning", async () => {
  await writeConfig((c) => { c.customers["Kapoor Builders"] = { code: "KAPOOR", monthlyFee: 1000, description: "x", incomeLedger: "Consulting Income" }; return c; });
  const p = await preview();
  assert.match(p.warnings.join(), /"Kapoor Builders" .* not in the Tally Retainer group/);
  assert.ok(!p.rows.some((r) => r.customer === "Kapoor Builders"));
});

test("bad period / future invoice date / invalid config are refused", async () => {
  await assert.rejects(R.previewRetainerInvoices({ period: "2026-13" }), /must be YYYY-MM/);
  await assert.rejects(R.previewRetainerInvoices({ period: "2099-01" }), /in the future/);
  await writeConfig((c) => { c.email.body += " {iban}"; return c; });
  await assert.rejects(preview(), /unknown placeholder\(s\) \{iban\}/);
  await writeConfig((c) => { c.invoiceDay = 5; return c; });
  await assert.rejects(preview(), /invoiceDay 5 is not in allowedInvoiceDays/);
  await writeConfig((c) => { c.customers["Gupta Healthcare"].monthlyFee = -1; return c; });
  await assert.rejects(preview(), /monthlyFee must be a number > 0/);
});

// ---------- write gates ----------

test("create is refused (and writes nothing) without the switch, approval code, right company or unchanged data", async () => {
  const code = (await preview()).approvalCode;
  process.env.INVOICE_WRITE_ENABLED = "false";
  await assert.rejects(R.createRetainerInvoices({ approvalCode: code }), /switched off/);
  process.env.INVOICE_WRITE_ENABLED = "true";
  await assert.rejects(R.createRetainerInvoices({}), /approvalCode .* is required/);
  await assert.rejects(R.createRetainerInvoices({ approvalCode: "INV-00000000" }), /does not match/);
  await writeConfig((c) => { c.customers["Sharma Exports Pvt Ltd"].monthlyFee = 26000; return c; });
  await assert.rejects(R.createRetainerInvoices({ approvalCode: code }), /does not match the current data/);
  await writeConfig((c) => { c.writeCompany = "Real Company Ltd"; return c; });
  await assert.rejects(R.createRetainerInvoices({ approvalCode: code }), /only allowed in the company "Real Company Ltd"/);
  await writeConfig();
  await assert.rejects(R.createRetainerInvoices({ approvalCode: code, customers: ["Kapoor Builders"] }), /Not Retainer customers/);
  assert.equal(tallyWrites().length, 0);
});

test("create refuses when the company is not open in Tally", async () => {
  const code = (await preview()).approvalCode;
  tally.state.company = "Other Co";
  try { await assert.rejects(R.createRetainerInvoices({ approvalCode: code }), /not open in Tally/); }
  finally { tally.state.company = "Demo Trading Co"; }
  assert.equal(tallyWrites().length, 0);
});

// ---------- create ----------

test("create: one balanced Sales voucher per customer, verified, PDF exported, local draft with the PDF", async () => {
  const r = await create();
  assert.equal(r.sent, false);
  assert.deepEqual(r.counts, { created: 3 });
  const sharma = r.results.find((x) => x.customer === "Sharma Exports Pvt Ltd");
  assert.equal(sharma.status, "created");
  assert.ok(sharma.voucherNumber && sharma.masterId);

  // The XML sent to Tally: debit = credits, bill reference with credit period, tag in narration.
  const xml = tally.state.imports.find((v) => v.includes("Sharma Exports"));
  const amounts = [...xml.matchAll(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
  assert.deepEqual(amounts, [-29500, 25000, 2250, 2250]);
  assert.match(xml, /<NAME>RET\/\d{4}-\d{2}\/SHARMA<\/NAME><BILLTYPE>New Ref<\/BILLTYPE>/);
  assert.match(xml, /<BILLCREDITPERIOD JD="\d+" P="15 Days">/);
  assert.match(xml, new RegExp(`<NARRATION>Retainer fee - [A-Za-z]+ \\d{4} \\[retainer:${period()}:SHARMA\\]</NARRATION>`));
  assert.match(xml, /<DATE>\d{6}01<\/DATE>/);
  assert.equal(tallyWrites().length, 3, "exactly one write per invoice");

  // PDF + local draft
  assert.equal(sharma.draft.status, "saved");
  assert.ok(existsSync(sharma.draft.pdf));
  assert.match(await readFile(sharma.draft.pdf, "utf8"), /^%PDF[\s\S]*total 29500\.00/);
  assert.doesNotMatch(await readFile(sharma.draft.pdf, "utf8"), /Accounting Voucher Display/, "Tally title bar removed");
  const eml = await readFile(sharma.draft.file, "utf8");
  assert.match(eml, /^X-Unsent: 1\r\nTo: accounts@sharma-exports\.example\.com\r\n/);
  assert.match(eml, /Content-Disposition: attachment; filename="Invoice RET-\d{4}-\d{2}-SHARMA\.pdf"/);

  const log = await readAudit();
  assert.deepEqual(log.filter((e) => e.action === "retainer_invoice").map((e) => e.status), ["pending", "created", "pending", "created", "pending", "created"]);
  assert.ok(log.every((e) => e.body === undefined && e.text === undefined), "no email bodies in the audit log");
});

test("email draft text: template filled with Indian formats", async () => {
  await create({ customers: ["Gupta Healthcare"] });
  const eml = await readFile((await readdir(join(tmp, "drafts", businessDate()))).map((f) => join(tmp, "drafts", businessDate(), f))[0], "utf8");
  const text = Buffer.from(eml.match(/text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/)[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(text, /^Dear Gupta Healthcare Accounts Team,/);
  assert.match(text, /Invoice RET\/\d{4}-\d{2}\/GUPTA \| Dated 01-[A-Z][a-z]{2}-\d{4} \| Due \d{2}-[A-Z][a-z]{2}-\d{4} \| Amount ₹47,200/);
});

test("duplicate: a second run creates nothing (already_invoiced via the Tally tag), no approval code", async () => {
  await create();
  const p = await preview();
  assert.deepEqual(p.counts, { ready: 0, already_invoiced: 3, blocked: 0, needs_setup: 0 });
  assert.equal(p.approvalCode, null);
  assert.match(p.rows[0].existing.source, /created by this workflow/);
  await assert.rejects(R.createRetainerInvoices({ approvalCode: p.approvalCode }), /approvalCode .* is required/);
  assert.equal(tallyWrites().length, 3);
});

test("duplicate: a manual Retainer sales voucher in the same month blocks that customer only", async () => {
  tally.state.vouchers.push({ date: `${period()}-01`, type: "Sales", number: "77", narration: "Retainer - this month",
    allocs: [["Verma Textiles", "MANUAL-1", -17700]] });
  const p = await preview();
  const verma = p.rows.find((r) => r.customer === "Verma Textiles");
  assert.equal(verma.status, "already_invoiced");
  assert.match(verma.existing.source, /"Retainer" in its narration/);
  const r = await R.createRetainerInvoices({ approvalCode: p.approvalCode });
  assert.deepEqual(r.counts, { created: 2, skipped_duplicate: 1 });
});

test("a different sales voucher to the customer in the month is only a note, not a block", async () => {
  tally.state.vouchers.push({ date: `${period()}-01`, type: "Sales", number: "78", narration: "Extra audit work",
    allocs: [["Verma Textiles", "X-1", -5000]] });
  const verma = (await preview()).rows.find((r) => r.customer === "Verma Textiles");
  assert.equal(verma.status, "ready");
  assert.match(verma.notes.join(), /Other Sales voucher\(s\) .* 78 \(Extra audit work\)/);
});

test("Tally rejects the voucher: status error, nothing retried, a later run may try again", async () => {
  tally.state.importMode = "reject";
  const r = await create({ customers: ["Sharma Exports Pvt Ltd"] });
  assert.equal(r.results[0].status, "error");
  assert.match(r.results[0].reason, /Voucher totals do not match/);
  assert.equal(r.results[0].draft, undefined);
  assert.equal(tallyWrites().length, 1);
  tally.state.importMode = "ok";
  assert.equal((await preview()).rows.find((x) => x.customer === "Sharma Exports Pvt Ltd").status, "ready");
});

test("Tally gives no clear answer: status unknown, blocked for 10 minutes, then allowed only if Tally shows nothing", async () => {
  tally.state.importMode = "fail";
  const r = await create({ customers: ["Sharma Exports Pvt Ltd"] });
  assert.equal(r.results[0].status, "unknown");
  assert.match(r.results[0].reason, /MAY have been created .* Not retried/);
  tally.state.importMode = "ok";
  const soon = (await preview()).rows.find((x) => x.customer === "Sharma Exports Pvt Ltd");
  assert.equal(soon.status, "blocked");
  assert.match(soon.issues.join(), /Wait 10 minutes/);
  const later = (await R.previewRetainerInvoices({ now: new Date(Date.now() + 11 * 60000) })).rows.find((x) => x.customer === "Sharma Exports Pvt Ltd");
  assert.equal(later.status, "ready");
  assert.match(later.notes.join(), /did not get a clear answer/);
});

test("Tally says created but the voucher can't be read back: created_unverified, then blocked until checked", async () => {
  tally.state.importMode = "phantom";
  const r = await create({ customers: ["Sharma Exports Pvt Ltd"] });
  assert.equal(r.results[0].status, "created_unverified");
  assert.match(r.results[0].reason, /could not be read back/);
  assert.equal(r.results[0].draft, undefined, "no draft without a verified voucher id");
  tally.state.importMode = "ok";
  const p = (await preview()).rows.find((x) => x.customer === "Sharma Exports Pvt Ltd");
  assert.equal(p.status, "blocked");
  assert.match(p.issues.join(), /audit log says invoice .* was created .* Tally does not show it/);
});

test("customer without email: invoice created, draft rejected; save_invoice_drafts later once the email is added", async () => {
  tally.state.ledgers.find((l) => l.name === "Verma Textiles").email = "";
  const p = await preview();
  assert.match(p.rows.find((r) => r.customer === "Verma Textiles").notes.join(), /No valid email/);
  const r = await R.createRetainerInvoices({ approvalCode: p.approvalCode, customers: ["Verma Textiles"] });
  assert.equal(r.results[0].status, "created");
  assert.equal(r.results[0].draft.status, "rejected");
  tally.state.ledgers.find((l) => l.name === "Verma Textiles").email = "billing@verma-textiles.example.com";
  const d = await R.saveInvoiceDrafts({});
  assert.deepEqual(d.results.map((x) => [x.customer, x.status]), [["Verma Textiles", "saved"]]);
  const again = await R.saveInvoiceDrafts({});
  assert.equal(again.results[0].status, "skipped_duplicate", "one draft per invoice");
});

test("Gmail destination: draft in Gmail with the invoice PDF attached, never sent", async () => {
  await connectGmail();
  const r = await create({ destination: "gmail", customers: ["Gupta Healthcare"] });
  const d = r.results[0].draft;
  assert.equal(d.status, "saved");
  assert.equal(d.gmailMessageId, "m-d1");
  const raw = g.state.drafts[0].raw;
  assert.deepEqual(g.state.drafts[0].labelIds, ["DRAFT"]);
  assert.match(raw, /^To: finance@gupta-health\.example\.com\r\n/);
  assert.match(raw, /Content-Type: application\/pdf; name="Invoice RET-\d{4}-\d{2}-GUPTA\.pdf"/);
  assert.equal(g.state.requests.filter((q) => /send/i.test(q.path)).length, 0);
});

test("Gmail not connected: nothing is created in Tally (checked before any write)", async () => {
  const code = (await preview()).approvalCode;
  await assert.rejects(R.createRetainerInvoices({ approvalCode: code, destination: "gmail" }), /Gmail: .*Nothing was created/);
  assert.equal(tallyWrites().length, 0);
});

test("PDF export failure: invoice stays created, draft reports the error, retry via save_invoice_drafts", async () => {
  const keep = pdfMod.renderer.htmlToPdf;
  pdfMod.renderer.htmlToPdf = async () => { throw new Error("Edge crashed"); };
  try {
    const r = await create({ customers: ["Sharma Exports Pvt Ltd"] });
    assert.equal(r.results[0].status, "created");
    assert.equal(r.results[0].draft.status, "error");
    assert.match(r.results[0].draft.reason, /Edge crashed/);
  } finally { pdfMod.renderer.htmlToPdf = keep; }
  const d = await R.saveInvoiceDrafts({ customers: ["Sharma Exports Pvt Ltd"] });
  assert.equal(d.results[0].status, "saved");
});

test("invoice HTML request only accepts a numeric Tally id", () => {
  assert.throws(() => pdfMod.invoiceHtmlRequest('1"/><X'), /Invalid Tally MasterID/);
  assert.match(pdfMod.invoiceHtmlRequest(" 42"), /Voucher : "ID:42"/);
});
