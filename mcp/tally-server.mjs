// Tally MCP server (stdio). Exposes TallyPrime data to Claude as tools.
// Tally access is READ-ONLY: every Tally tool sends only Export requests — nothing is written to Tally.
// The one write tool (save_reminder_draft) only saves a local draft email file and an audit log line.
// Run: node mcp/tally-server.mjs   (normally launched by the MCP client via .mcp.json)
// NOTE: stdout is the MCP protocol channel — log only to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TALLY_URL, COMPANY, tallyFetch, postXml, collectionRequest, decode } from "../lib/tally.mjs";
import { field } from "../lib/receivables.mjs";
import { receivablesView, ageingView } from "../lib/report.mjs";
import { bucketLabels } from "../lib/ageing.mjs";
import { CONFIG } from "../lib/config.mjs";
import { createReminderDraft } from "../lib/reminders.mjs";

const server = new McpServer({ name: "tally", version: "0.1.0" });

const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: Array.isArray(data) ? { rows: data } : data,
});
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: err.rule
    ? err.message // a business rule / configuration problem, not a connection problem
    : `Tally request failed: ${err.message}. Check that TallyPrime is open, ` +
      `company "${COMPANY}" is loaded, and the HTTP server is enabled at ${TALLY_URL}.` }],
});
const tool = (name, meta, fn) =>
  server.registerTool(name, { ...meta, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toTallyDate = (d) => d.replaceAll("-", "");
// Tally amounts: negative = Debit, positive = Credit.
const drCr = (n) => ({ amount: Math.abs(n), side: n < 0 ? "Dr" : n > 0 ? "Cr" : "" });

tool("tally_status", {
  title: "Tally status",
  description: "Check that TallyPrime is reachable and list the companies currently open.",
}, async () => {
  const ping = (await tallyFetch()).replace(/<[^>]+>/g, "").trim();
  const xml = await postXml(collectionRequest("CompanyList", "Company", ["Name"]));
  const companies = [...xml.matchAll(/<COMPANY NAME="([^"]*)"/g)].map((m) => decode(m[1]));
  return { server: ping, url: TALLY_URL, configuredCompany: COMPANY, openCompanies: companies };
});

tool("list_ledgers", {
  title: "List ledgers",
  description: "List ledgers with parent group, email and closing balance (Dr/Cr). Optionally filter by group name.",
  inputSchema: { group: z.string().optional().describe('Exact parent group, e.g. "Sundry Debtors"') },
}, async ({ group }) => {
  const xml = await postXml(collectionRequest("L", "Ledger", ["Name", "Parent", "Email", "ClosingBalance"]));
  return [...xml.matchAll(/<LEDGER NAME="([^"]*)"[\s\S]*?<\/LEDGER>/g)]
    .map((m) => ({
      ledger: decode(m[1]),
      group: decode(field(m[0], "PARENT")),
      email: decode(field(m[0], "EMAIL")),
      closingBalance: drCr(Number(field(m[0], "CLOSINGBALANCE") || 0)),
    }))
    .filter((l) => !group || l.group.toLowerCase() === group.toLowerCase());
});

const filters = {
  asOf: isoDate.optional().describe("Ageing date, default today (India time). Past dates are refused unless enabled in config."),
  customer: z.string().optional().describe("Case-insensitive substring match on customer name"),
  retainerOnly: z.boolean().optional().describe(`Only Retainer customers (group "${CONFIG.retainerGroup}" and its sub-groups)`),
};

tool("get_receivables", {
  title: "Outstanding receivables",
  description: "Bill-wise open receivables of customers (Sundry Debtors, incl. sub-groups): bill date, due date " +
    "(+ dueDateSource), overdue days, balance (net of part payments) and customer email status. `bills` = bills " +
    "worth chasing: overdue by >= minOverdueDays, balance >= minAmount, not on hold. `customers` gives each " +
    "customer's unadjusted advances/credits, netOverdue and whether a reminder is allowed (reminder.eligible / " +
    "reminder.reason). Left-out bills are listed in onHold, belowThreshold and billsWithIssues — report them.",
  inputSchema: {
    ...filters,
    minOverdueDays: z.number().int().min(0).optional().describe("Only bills overdue by at least this many days, e.g. 30, 60, 90"),
    minAmount: z.number().min(0).optional().describe(`Only bills with balance >= this (INR). Default ${CONFIG.minBillBalance}`),
  },
}, (args) => receivablesView(args));

tool("get_ageing_report", {
  title: "Outstanding ageing report",
  description: `Customer-wise ageing of receivables in buckets (${bucketLabels(CONFIG.ageingBuckets).join(", ")}) by days ` +
    "overdue from the due date, with unadjusted advances/credit notes, on-account amounts, net due, Retainer flag, " +
    "hold status, email status, totals and warnings. includePayments adds each bill's billed amount and the " +
    "receipts/credit notes adjusted against it (slower: reads all vouchers).",
  inputSchema: {
    ...filters,
    includePayments: z.boolean().optional().describe("Add bill-wise payment history (default false)"),
  },
}, async (args) => {
  const v = await ageingView(args);
  return { ...v.report, ...(args.includePayments && { bills: v.rows }) };
});

tool("list_vouchers", {
  title: "List vouchers",
  description: "List vouchers (Sales, Receipt, etc.) in a date range with party, amount, narration and ledger entries.",
  inputSchema: {
    from: isoDate.describe("Start date YYYY-MM-DD"),
    to: isoDate.describe("End date YYYY-MM-DD"),
    voucherType: z.string().optional().describe('e.g. "Sales", "Receipt"'),
    party: z.string().optional().describe("Case-insensitive substring match on party ledger"),
  },
}, async ({ from, to, voucherType, party }) => {
  const xml = await postXml(collectionRequest("V", "Voucher",
    ["Date", "VoucherTypeName", "VoucherNumber", "PartyLedgerName", "Amount", "Narration"],
    { from: toTallyDate(from), to: toTallyDate(to) }));
  return [...xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map(([v]) => ({
    date: field(v, "DATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
    type: decode(field(v, "VOUCHERTYPENAME")),
    number: field(v, "VOUCHERNUMBER").trim(),
    party: decode(field(v, "PARTYLEDGERNAME")),
    amount: Math.abs(Number(field(v, "AMOUNT") || 0)),
    narration: decode(field(v, "NARRATION")),
    entries: [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g)].map(([e]) => ({
      ledger: decode(field(e, "LEDGERNAME")), ...drCr(Number(field(e, "AMOUNT") || 0)),
    })),
  })).filter((v) =>
    // Tally doesn't apply SVFROMDATE/SVTODATE to collection exports, so filter dates here too.
    v.date >= from && v.date <= to &&
    (!voucherType || v.type.toLowerCase() === voucherType.toLowerCase()) &&
    (!party || v.party.toLowerCase().includes(party.toLowerCase())));
});

// The only tool that writes — a local draft file plus an audit log line. Never writes to Tally, never sends.
// Checks are enforced in lib/reminders.mjs: recipient comes from the Tally ledger, bills must be open,
// duplicates within the cooldown are skipped, every attempt is audit-logged.
server.registerTool("save_reminder_draft", {
  title: "Save reminder draft",
  description: "Save one payment reminder email as a draft .eml file under drafts/<today>/<customer>.eml. " +
    "The recipient is taken from the customer's ledger email in Tally (you cannot set it). " +
    "Every bill listed must be an open receivable of that customer and be mentioned in the body. " +
    "Bills already drafted in the last few days are skipped (status skipped_duplicate) — do not retry those. " +
    "Does NOT send the email and does NOT change Tally.",
  inputSchema: {
    customer: z.string().min(1).describe("Exact customer ledger name from get_receivables"),
    bills: z.array(z.string().min(1)).min(1).describe("Bill numbers included in this email, e.g. [\"DEMO-001\"]"),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).describe("Plain-text email body including signature"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  try {
    return ok(await createReminderDraft(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Draft not saved: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
console.error(`tally MCP server ready (Tally: ${TALLY_URL}, company: ${COMPANY})`);
