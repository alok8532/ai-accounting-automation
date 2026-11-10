// Monthly Retainer invoices (proposal Capability 4 / Workflow A). The rules live HERE, in code:
//  1. Identify: customers in the Tally Retainer group (config/receivables.json → retainerGroup). Billing terms
//     come only from config/retainer-billing.json — a Retainer customer without agreed terms is flagged
//     (needs_setup), never guessed.
//  2. Preview (read-only): fee, CGST/SGST, total, invoice date, due date (ledger credit days), recipient.
//     Missing ledgers / credit period → blocked. Returns an approval code = hash of exactly what will be
//     created (valid today only; any change in Tally or the config changes it).
//  3. Create (the ONLY Tally write in this project): needs INVOICE_WRITE_ENABLED=true, the configured
//     company, and the approval code from the preview the user confirmed. Re-runs the preview and
//     refuses if anything changed. One Sales voucher per customer and period, with a fixed bill reference
//     RET/<period>/<code> and a [retainer:<period>:<code>] tag in the narration.
//  4. Duplicate protection: the tag/bill reference in Tally, a Retainer sales voucher already in that month,
//     and the audit log. A "pending" audit line is written BEFORE each write; a write whose result is
//     unclear is never retried automatically (blocked until Tally can be checked).
//  5. Verify: the voucher is read back from Tally and its total compared with the preview.
//  6. PDF: Tally's own printed invoice (lib/invoice-pdf.mjs) → invoices/<period>/.
//  7. Email draft with the PDF attached (local .eml, or a Gmail draft). Never sent.
// Every attempt is audit-logged (logs/reminder-audit.jsonl) without email bodies.

import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "./config.mjs";
import { loadDotEnv } from "./env.mjs";
import { COMPANY, esc, decode, postXml, collectionRequest, importData } from "./tally.mjs";
import { getLedgers, field } from "./receivables.mjs";
import { checkEmails } from "./email.mjs";
import { audit, readAudit } from "./audit.mjs";
import { businessDate, DAY } from "./dates.mjs";
import { exportInvoicePdf } from "./invoice-pdf.mjs";
import { buildMessage } from "./mime.mjs";
import { DRAFTS_DIR, slug } from "./drafts.mjs";
import { createGmailDraft } from "./gmail/client.mjs";
import { connectedAccount, getAccessToken } from "./gmail/oauth.mjs";
import { gmailDraftLink } from "./gmail/links.mjs";
import { resolveDestination } from "./reminders.mjs";

loadDotEnv();
export const INVOICES_DIR = resolve(process.env.INVOICES_DIR ?? join(ROOT, "invoices"));
const BILLING_FILE = resolve(process.env.RETAINER_BILLING_CONFIG || join(ROOT, "config", "retainer-billing.json"));
const UNCLEAR_WAIT_MS = 10 * 60000; // after an unclear write, wait before trusting "not in Tally"

class RuleError extends Error { constructor(m) { super(m); this.rule = true; } }
const rule = (m) => { throw new RuleError(m); };

const round2 = (n) => Math.round(n * 100) / 100;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dmy = (iso) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
export const inr = (n) => `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n)}`;
const addDays = (iso, d) => new Date(Date.parse(iso) + d * DAY).toISOString().slice(0, 10);
const tallyJD = (iso) => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 31)) / DAY);
const PLACEHOLDERS = ["customer", "billRef", "periodName", "invoiceDate", "dueDate", "total", "fee", "gst"];

// ---------- config (fails loudly: a wrong value could bill a customer wrongly) ----------

export function loadBillingConfig() {
  let c;
  try { c = JSON.parse(readFileSync(BILLING_FILE, "utf8")); } catch (e) { rule(`Cannot read ${BILLING_FILE}: ${e.message}`); }
  const errs = [];
  const str = (v) => typeof v === "string" && v.trim();
  if (!str(c.writeCompany)) errs.push("writeCompany must be the Tally company name invoices may be created in");
  if (!str(c.voucherType)) errs.push("voucherType must be set (e.g. \"Sales\")");
  if (!Number.isInteger(c.invoiceDay) || c.invoiceDay < 1 || c.invoiceDay > 28 && c.invoiceDay !== 31) errs.push("invoiceDay must be 1–28 or 31");
  if (!Array.isArray(c.allowedInvoiceDays) || c.allowedInvoiceDays.some((d) => !Number.isInteger(d)))
    errs.push("allowedInvoiceDays must be a list of day numbers ([] = any day)");
  else if (c.allowedInvoiceDays.length && !c.allowedInvoiceDays.includes(c.invoiceDay))
    errs.push(`invoiceDay ${c.invoiceDay} is not in allowedInvoiceDays ${JSON.stringify(c.allowedInvoiceDays)}`);
  if (!/^[A-Z0-9]{1,10}$/.test(c.billRefPrefix ?? "")) errs.push("billRefPrefix must be 1–10 capital letters/digits");
  const g = c.gst ?? {};
  for (const k of ["cgstLedger", "sgstLedger"]) if (!str(g[k])) errs.push(`gst.${k} must be a ledger name`);
  for (const k of ["cgstRate", "sgstRate"]) if (typeof g[k] !== "number" || g[k] < 0 || g[k] > 50) errs.push(`gst.${k} must be a number 0–50`);
  const codes = new Set();
  for (const [name, x] of Object.entries(c.customers ?? {})) {
    if (!/^[A-Z0-9]{2,12}$/.test(x?.code ?? "")) errs.push(`customers["${name}"].code must be 2–12 capital letters/digits`);
    else if (codes.has(x.code)) errs.push(`customers code "${x.code}" is used twice`); else codes.add(x.code);
    if (typeof x?.monthlyFee !== "number" || !(x.monthlyFee > 0)) errs.push(`customers["${name}"].monthlyFee must be a number > 0`);
    if (!str(x?.description)) errs.push(`customers["${name}"].description must be set`);
    if (!str(x?.incomeLedger)) errs.push(`customers["${name}"].incomeLedger must be set`);
  }
  for (const k of ["subject", "body"]) {
    if (!str(c.email?.[k])) { errs.push(`email.${k} must be set`); continue; }
    const bad = [...c.email[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => !PLACEHOLDERS.includes(p));
    if (bad.length) errs.push(`email.${k} has unknown placeholder(s) ${bad.map((b) => `{${b}}`).join(", ")} (allowed: ${PLACEHOLDERS.join(", ")})`);
  }
  if (errs.length) rule(`Invalid ${BILLING_FILE}: ${errs.join("; ")}`);
  return c;
}

// ---------- reading Tally ----------

export async function readVouchers() {
  const xml = await postXml(collectionRequest("RV", "Voucher",
    ["Date", "VoucherTypeName", "VoucherNumber", "PartyLedgerName", "Narration", "MasterID"]));
  return [...xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map(([v]) => ({
    date: field(v, "DATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
    type: decode(field(v, "VOUCHERTYPENAME")),
    number: decode(field(v, "VOUCHERNUMBER")).trim(),
    party: decode(field(v, "PARTYLEDGERNAME")),
    narration: decode(field(v, "NARRATION")),
    masterId: field(v, "MASTERID").trim(),
    entries: [...v.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/g)].map(([e]) => ({
      ledger: decode(field(e, "LEDGERNAME")), amount: Number(field(e, "AMOUNT") || 0),
      bills: [...e.matchAll(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g)].map(([b]) => decode(field(b, "NAME"))),
    })),
  }));
}
// Invoice total = the customer's debit on the voucher (Tally: debit is negative).
const partyTotal = (v, customer) => round2(-v.entries.filter((e) => e.ledger === customer).reduce((s, e) => s + e.amount, 0));

// ---------- preview ----------

function periodInfo(period, cfg, now) {
  const today = businessDate(now);
  period ??= today.slice(0, 7);
  const m = String(period).match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) rule(`Billing period must be YYYY-MM, e.g. "${today.slice(0, 7)}" (got "${period}")`);
  const lastDay = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  if (cfg.invoiceDay > lastDay) rule(`invoiceDay ${cfg.invoiceDay} does not exist in ${period}`);
  const invoiceDate = `${period}-${String(cfg.invoiceDay).padStart(2, "0")}`;
  if (invoiceDate > today) rule(`The invoice date for ${period} would be ${dmy(invoiceDate)}, which is in the future. Retainer invoices are created on or after the invoice date.`);
  const periodName = new Date(`${period}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return { period, invoiceDate, periodName, today };
}

function invoiceAuditState(entries, billRef) {
  const mine = entries.filter((e) => e.action === "retainer_invoice" && e.billRef === billRef);
  const finished = new Set(mine.filter((e) => e.status !== "pending").map((e) => e.attemptId));
  return {
    created: mine.findLast((e) => e.status === "created" || e.status === "created_unverified"),
    unclear: mine.filter((e) => (e.status === "pending" && !finished.has(e.attemptId)) || e.status === "unknown"),
  };
}

export async function previewRetainerInvoices({ period, now = new Date() } = {}) {
  const cfg = loadBillingConfig();
  const p = periodInfo(period, cfg, now);
  const ledgers = await getLedgers();
  const vouchers = await readVouchers();
  const log = await readAudit();
  const warnings = [];

  const retainers = [...ledgers].filter(([, l]) => l.retainer && l.debtor).map(([n]) => n).sort();
  for (const name of Object.keys(cfg.customers)) {
    if (!ledgers.has(name)) warnings.push(`"${name}" has billing terms in the config but no ledger in Tally — ignored.`);
    else if (!retainers.includes(name)) warnings.push(`"${name}" has billing terms in the config but is not in the Tally Retainer group — ignored.`);
  }

  const rows = retainers.map((customer) => {
    const c = cfg.customers[customer];
    if (!c) return { customer, status: "needs_setup", issues: [`No agreed billing terms for "${customer}" in config/retainer-billing.json (monthly fee, description, income ledger).`] };
    const led = ledgers.get(customer);
    const issues = [];
    const notes = [];
    const billRef = `${cfg.billRefPrefix}/${p.period}/${c.code}`;
    const tag = `[retainer:${p.period}:${c.code}]`;
    for (const l of [c.incomeLedger, cfg.gst.cgstLedger, cfg.gst.sgstLedger])
      if (!ledgers.has(l)) issues.push(`Ledger "${l}" does not exist in Tally.`);
    const creditDays = led.defaultCreditDays;
    if (creditDays == null) issues.push("The customer ledger has no default credit period in Tally, so the due date is unknown. Set it in the ledger.");
    const email = checkEmails(led.email);
    if (email.status !== "valid") notes.push(`No valid email on the ledger (${email.status}) — the invoice can be created, but no email draft.`);

    const fee = round2(c.monthlyFee);
    const cgst = round2(fee * cfg.gst.cgstRate / 100);
    const sgst = round2(fee * cfg.gst.sgstRate / 100);
    const row = {
      customer, code: c.code, billRef, tag, description: c.description, incomeLedger: c.incomeLedger,
      fee, cgst, sgst, total: round2(fee + cgst + sgst), invoiceDate: p.invoiceDate,
      creditDays, dueDate: creditDays == null ? null : addDays(p.invoiceDate, creditDays),
      to: email.status === "valid" ? email.emails.join(", ") : null,
    };

    // Duplicate checks: Tally first (system of record), then the audit log.
    const exact = vouchers.find((v) => v.narration.includes(tag) || v.entries.some((e) => e.bills.includes(billRef)));
    const manual = !exact && vouchers.find((v) => v.party === customer && v.type.toLowerCase() === cfg.voucherType.toLowerCase() &&
      v.date.startsWith(p.period) && /retainer/i.test(v.narration));
    const others = vouchers.filter((v) => v !== manual && v.party === customer && v.date.startsWith(p.period) &&
      v.type.toLowerCase() === cfg.voucherType.toLowerCase() && !v.narration.includes(tag));
    const { created, unclear } = invoiceAuditState(log, billRef);
    if (exact || manual) {
      const v = exact || manual;
      return { ...row, status: "already_invoiced", issues: [], notes,
        existing: { voucherNumber: v.number, date: v.date, total: partyTotal(v, customer), masterId: v.masterId,
          source: exact ? "created by this workflow" : `a ${v.type} voucher with "Retainer" in its narration ("${v.narration}") in ${p.period}` } };
    }
    if (created) issues.push(`The audit log says invoice ${billRef} was created on ${created.at.slice(0, 10)} (voucher ${created.voucherNumber ?? "?"}), but Tally does not show it now. Check Tally before creating it again.`);
    const recent = unclear.find((e) => now - new Date(e.at) < UNCLEAR_WAIT_MS);
    if (recent) issues.push(`An earlier attempt at ${recent.at} did not get a clear answer from Tally. Wait 10 minutes, check Tally's Day Book, then preview again.`);
    else if (unclear.length) notes.push(`An earlier attempt (${unclear.at(-1).at}) did not get a clear answer from Tally; Tally now shows no such invoice, so it can be created.`);
    if (others.length) notes.push(`Other ${cfg.voucherType} voucher(s) to this customer in ${p.period}: ${others.map((v) => `${v.number} (${v.narration || "no narration"})`).join("; ")}.`);
    return { ...row, status: issues.length ? "blocked" : "ready", issues, notes };
  });

  const ready = rows.filter((r) => r.status === "ready");
  const sum = (k) => round2(ready.reduce((s, r) => s + r[k], 0));
  const approvalCode = ready.length ? `INV-${createHash("sha256").update(JSON.stringify({
    company: COMPANY, today: p.today, period: p.period, invoiceDate: p.invoiceDate,
    rows: ready.map((r) => [r.customer, r.billRef, r.fee, r.cgst, r.sgst, r.total, r.dueDate, r.incomeLedger, r.description, r.to]),
  })).digest("hex").slice(0, 8).toUpperCase()}` : null;

  return {
    company: COMPANY, period: p.period, periodName: p.periodName, invoiceDate: p.invoiceDate,
    writeEnabled: (loadDotEnv(), process.env.INVOICE_WRITE_ENABLED === "true") && COMPANY === cfg.writeCompany,
    counts: Object.fromEntries(["ready", "already_invoiced", "blocked", "needs_setup"].map((s) => [s, rows.filter((r) => r.status === s).length])),
    totals: { fee: sum("fee"), gst: round2(sum("cgst") + sum("sgst")), total: sum("total") },
    approvalCode, approvalNote: approvalCode && `Valid today (${p.today}) for exactly these ${ready.length} invoice(s). Any change in Tally or the config needs a new preview.`,
    rows, warnings,
  };
}

// ---------- create (Tally write) ----------

function salesVoucherXml(r, cfg, periodName) {
  const amt = (n) => n.toFixed(2);
  const entry = (ledger, amount, extra = "") => `
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(ledger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>${amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <AMOUNT>${amt(amount)}</AMOUNT>${extra}
  </ALLLEDGERENTRIES.LIST>`;
  // Debit (customer) is negative, credits positive. BILLCREDITPERIOD JD = bill date, P = credit period (→ due date).
  const bill = `
    <BILLALLOCATIONS.LIST>
      <NAME>${esc(r.billRef)}</NAME><BILLTYPE>New Ref</BILLTYPE>
      <BILLCREDITPERIOD JD="${tallyJD(r.invoiceDate)}" P="${r.creditDays} Days">${r.creditDays} Days</BILLCREDITPERIOD>
      <AMOUNT>${amt(-r.total)}</AMOUNT>
    </BILLALLOCATIONS.LIST>`;
  return `<VOUCHER VCHTYPE="${esc(cfg.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>${r.invoiceDate.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${esc(cfg.voucherType)}</VOUCHERTYPENAME>
  <REFERENCE>${esc(r.billRef)}</REFERENCE>
  <PARTYLEDGERNAME>${esc(r.customer)}</PARTYLEDGERNAME>
  <NARRATION>${esc(`${r.description} - ${periodName} ${r.tag}`)}</NARRATION>
  <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${entry(r.customer, -r.total, bill)}${entry(r.incomeLedger, r.fee)}${entry(cfg.gst.cgstLedger, r.cgst)}${entry(cfg.gst.sgstLedger, r.sgst)}
</VOUCHER>`;
}

async function createOne(r, cfg, preview, runId, approvalCode) {
  const attemptId = randomUUID();
  const base = { action: "retainer_invoice", runId, approvalCode, attemptId, period: preview.period, customer: r.customer, billRef: r.billRef,
    total: r.total, invoiceDate: r.invoiceDate, dueDate: r.dueDate };
  const out = { customer: r.customer, billRef: r.billRef, total: r.total, invoiceDate: r.invoiceDate, dueDate: r.dueDate };
  await audit({ ...base, status: "pending" });
  let res;
  try {
    res = await importData("Vouchers", salesVoucherXml(r, cfg, preview.periodName));
  } catch (e) {
    await audit({ ...base, status: "unknown", reason: e.message });
    return { ...out, status: "unknown", reason: `Tally did not answer clearly (${e.message}). The invoice MAY have been created — check Tally's Day Book. Not retried.` };
  }
  if (res.errors || res.created !== 1) {
    const reason = `Tally did not create the invoice: ${res.lineErrors.join("; ") || `created=${res.created}, errors=${res.errors}`}`;
    await audit({ ...base, status: "error", reason });
    return { ...out, status: "error", reason };
  }
  let v = null;
  try { v = (await readVouchers()).find((x) => x.narration.includes(r.tag)); } catch { /* reported below */ }
  const tallyTotal = v ? partyTotal(v, r.customer) : null;
  if (!v || Math.abs(tallyTotal - r.total) > 0.005) {
    const reason = v ? `Tally shows total ${inr(tallyTotal)}, preview was ${inr(r.total)} — check the voucher in Tally.`
      : "Tally reported the invoice as created, but it could not be read back — check Tally.";
    await audit({ ...base, status: "created_unverified", voucherNumber: v?.number, masterId: v?.masterId, reason });
    return { ...out, status: "created_unverified", voucherNumber: v?.number ?? null, masterId: v?.masterId ?? null, reason };
  }
  await audit({ ...base, status: "created", voucherNumber: v.number, masterId: v.masterId });
  return { ...out, status: "created", voucherNumber: v.number, masterId: v.masterId };
}

async function writeGate(cfg) {
  loadDotEnv();
  if (process.env.INVOICE_WRITE_ENABLED !== "true")
    rule("Invoice creation is switched off. Take a Tally backup, set INVOICE_WRITE_ENABLED=true in .env, then restart Claude.");
  if (COMPANY !== cfg.writeCompany)
    rule(`Invoice creation is only allowed in the company "${cfg.writeCompany}" (config/retainer-billing.json); this server is set to "${COMPANY}".`);
  const xml = await postXml(collectionRequest("CompanyList", "Company", ["Name"]));
  const open = [...xml.matchAll(/<COMPANY NAME="([^"]*)"/g)].map((m) => decode(m[1]));
  if (!open.includes(COMPANY)) rule(`Company "${COMPANY}" is not open in Tally (open: ${open.join(", ") || "none"}).`);
}

async function gmailGate(destination) {
  if (destination !== "gmail") return;
  try { await getAccessToken(); } catch (e) { rule(`Gmail: ${e.message} Nothing was created. Fix Gmail first, or use destination "local".`); }
}

const counts = (results) => results.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});

export async function createRetainerInvoices({ period, approvalCode, customers, destination, now = new Date() } = {}) {
  const cfg = loadBillingConfig();
  destination = resolveDestination(destination);
  const runId = `inv-${businessDate(now)}-${randomUUID().slice(0, 8)}`;
  // Approval trail: every attempt to create invoices is recorded — refused ones too (who: the audit
  // entry's `user` is the OS user running the server; what was approved: the approval code + criteria).
  const run = { action: "retainer_invoice_run", runId, workflow: "retainer-invoices", approvalCode: approvalCode ?? null,
    period: period ?? null, customers: customers?.length ? customers : "all ready", destination };
  const refuse = async (reason) => { await audit({ ...run, status: "refused", reason }).catch(() => {}); rule(reason); };
  try { await writeGate(cfg); } catch (e) { if (e.rule) await refuse(e.message); throw e; } // switched off / wrong company / not open
  if (!approvalCode) await refuse("An approvalCode from preview_retainer_invoices is required — show the preview to the user and get their confirmation first.");
  await gmailGate(destination);
  const preview = await previewRetainerInvoices({ period, now });
  if (preview.approvalCode !== approvalCode)
    await refuse("The approval code does not match the current data (something changed in Tally or the config, or the code is from an earlier day). Nothing was created. Run the preview again and get a fresh confirmation.");

  const want = customers?.length ? new Set(customers.map((c) => c.trim().toLowerCase())) : null;
  const unknown = want ? [...want].filter((w) => !preview.rows.some((r) => r.customer.toLowerCase() === w)) : [];
  if (unknown.length) await refuse(`Not Retainer customers in the preview: ${unknown.join(", ")}. Nothing was created.`);
  const selected = preview.rows.filter((r) => r.status === "ready" && (!want || want.has(r.customer.toLowerCase())));
  await audit({ ...run, status: "approved", company: COMPANY, period: preview.period, invoiceDate: preview.invoiceDate,
    invoices: selected.map((r) => r.billRef), invoiceCount: selected.length, total: round2(selected.reduce((s, r) => s + r.total, 0)) });
  const results = [];
  for (const r of preview.rows) {
    if (want && !want.has(r.customer.toLowerCase())) continue;
    if (r.status !== "ready") {
      results.push({ customer: r.customer, billRef: r.billRef, status: r.status === "already_invoiced" ? "skipped_duplicate" : "skipped",
        reason: r.status === "already_invoiced" ? `Already invoiced: voucher ${r.existing.voucherNumber} dated ${r.existing.date} (${r.existing.source})` : r.issues.join(" ") });
      continue;
    }
    const inv = await createOne(r, cfg, preview, runId, approvalCode);
    if (inv.status === "created" || (inv.status === "created_unverified" && inv.masterId)) {
      inv.draft = await draftForInvoice({ ...inv, period: preview.period, periodName: preview.periodName, fee: r.fee, gst: round2(r.cgst + r.sgst) },
        { destination, cfg, runId, now });
    }
    results.push(inv);
  }
  return { runId, company: COMPANY, period: preview.period, invoiceDate: preview.invoiceDate, destination, sent: false, counts: counts(results), results };
}

// ---------- PDF + email draft ----------

export const invoicePdfPath = (period, billRef) => join(INVOICES_DIR, period, `${billRef.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`);
const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k]);

// One email draft (with the invoice PDF) for one created invoice. Never throws: returns a status.
async function draftForInvoice(inv, { destination, cfg, runId, now }) {
  const base = { action: "invoice_draft", runId, period: inv.period, customer: inv.customer, billRef: inv.billRef, destination };
  try {
    const prev = (await readAudit()).findLast((e) => e.action === "invoice_draft" && e.billRef === inv.billRef && e.status === "saved");
    if (prev) return { status: "skipped_duplicate", reason: `An email draft for ${inv.billRef} was already saved on ${prev.at.slice(0, 10)}${prev.gmail ? " in Gmail" : ""}.` };
    const led = (await getLedgers()).get(inv.customer);
    const email = checkEmails(led?.email);
    if (email.status !== "valid") {
      const reason = `No valid email on the ledger "${inv.customer}" in Tally (${email.status}). Add it, then run save_invoice_drafts.`;
      await audit({ ...base, status: "rejected", reason });
      return { status: "rejected", reason };
    }
    const to = email.emails.join(", ");
    const pdf = invoicePdfPath(inv.period, inv.billRef);
    if (!existsSync(pdf)) {
      if (!inv.masterId) throw new Error("The Tally voucher id is unknown, so the PDF cannot be exported.");
      await exportInvoicePdf({ masterId: inv.masterId, pdfFile: pdf });
    }
    const v = { customer: inv.customer, billRef: inv.billRef, periodName: inv.periodName, invoiceDate: dmy(inv.invoiceDate),
      dueDate: inv.dueDate ? dmy(inv.dueDate) : "-", total: inr(inv.total), fee: inr(inv.fee ?? 0), gst: inr(inv.gst ?? 0) };
    const subject = fill(cfg.email.subject, v);
    const text = fill(cfg.email.body, v);
    const attachments = [{ filename: `Invoice ${inv.billRef.replaceAll("/", "-")}.pdf`, contentType: "application/pdf", content: await readFile(pdf) }];

    let gmail = null;
    if (destination === "gmail") {
      const attemptId = randomUUID();
      await audit({ ...base, status: "gmail_pending", attemptId });
      try {
        const r = await createGmailDraft({ to, subject, text, attachments });
        const account = (await connectedAccount().catch(() => null))?.account ?? null;
        gmail = { messageId: r.gmailMessageId, draftId: r.gmailDraftId, mode: r.gmailMode, account, link: gmailDraftLink(r.gmailMessageId, account) };
        base.attemptId = attemptId;
      } catch (e) {
        await audit({ ...base, status: "error", attemptId, reason: `Gmail: ${e.message}` });
        return { status: "error", reason: `Gmail: ${e.message}`, pdf };
      }
    }
    let file = null; // local .eml only for destination "local" — a Gmail draft has no local copy
    if (!gmail) {
      file = join(DRAFTS_DIR, businessDate(now), `invoice-${slug(inv.billRef)}.eml`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `X-Unsent: 1\r\n${buildMessage({ to, subject, text, attachments })}`, "utf8");
    }
    await audit({ ...base, status: "saved", to, subject, pdf, file, ...(gmail && { gmail }) });
    return { status: "saved", to, pdf, ...(file && { file }), ...(gmail && { gmailMessageId: gmail.messageId, gmailAccount: gmail.account, gmailLink: gmail.link }) };
  } catch (e) {
    await audit({ ...base, status: "error", reason: e.message }).catch(() => {});
    return { status: "error", reason: e.message };
  }
}

// Drafts for invoices of a period that were created earlier but have no saved draft yet
// (e.g. Gmail was not connected at the time). Never touches Tally except to read.
export async function saveInvoiceDrafts({ period, destination, customers, now = new Date() } = {}) {
  const cfg = loadBillingConfig();
  destination = resolveDestination(destination);
  await gmailGate(destination);
  const p = periodInfo(period, cfg, now);
  const log = await readAudit();
  const latest = new Map();
  for (const e of log) if (e.action === "retainer_invoice" && e.period === p.period && (e.status === "created" || e.status === "created_unverified")) latest.set(e.billRef, e);
  const want = customers?.length ? new Set(customers.map((c) => c.trim().toLowerCase())) : null;
  const runId = `invdraft-${businessDate(now)}-${randomUUID().slice(0, 8)}`;
  const results = [];
  for (const e of latest.values()) {
    if (want && !want.has(e.customer.toLowerCase())) continue;
    const c = cfg.customers[e.customer];
    const fee = c ? round2(c.monthlyFee) : undefined;
    const draft = await draftForInvoice({ customer: e.customer, billRef: e.billRef, period: p.period, periodName: p.periodName,
      invoiceDate: e.invoiceDate, dueDate: e.dueDate, total: e.total, masterId: e.masterId, fee, gst: fee != null ? round2(e.total - fee) : undefined },
    { destination, cfg, runId, now });
    results.push({ customer: e.customer, billRef: e.billRef, voucherNumber: e.voucherNumber, ...draft });
  }
  return { runId, period: p.period, destination, sent: false, counts: counts(results), results,
    ...(results.length ? {} : { message: `No invoices created by this workflow for ${p.period}.` }) };
}
