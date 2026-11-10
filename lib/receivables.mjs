// Bill-wise receivables from Tally, shared by the CLI scripts, reminders and the MCP server.
// Read-only: only Export requests are sent to Tally. Rules: docs/ACCOUNTING_RULES.md.

import { postXml, collectionRequest, decode } from "./tally.mjs";
import { DAY, toDateOnly, fmtDate } from "./dates.mjs";
import { CONFIG } from "./config.mjs";
import { checkEmails } from "./email.mjs";
import { resolveDueDate, overdueDays, daysBetween, round2 } from "./ageing.mjs";

export { fmtDate };
export const DEBTORS_GROUP = CONFIG.debtorsGroup;
export const RETAINER_GROUP = CONFIG.retainerGroup;

const fromJD = (jd) => new Date(Date.UTC(1899, 11, 31) + jd * DAY);
const ymd = (s) => (/^\d{8}$/.test(s) ? new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`) : null);

export const field = (block, tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]*)<`)) ?? [])[1] ?? "";
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// Group name -> parent group name ("Primary" for top-level groups).
export async function getGroupParents() {
  const gx = await postXml(collectionRequest("G", "Group", ["Name", "Parent"]));
  return new Map([...gx.matchAll(/<GROUP NAME="([^"]*)"[\s\S]*?<\/GROUP>/g)].map((m) => [
    decode(m[1]), decode(field(m[0], "PARENT")).trim(),
  ]));
}

// A group and all of its ancestors, e.g. ["Retainer Customers", "Sundry Debtors", "Current Assets", "Primary"].
export function groupChain(group, parents) {
  const chain = [];
  for (let g = group; g && !chain.includes(g); g = parents.get(g)) chain.push(g); // includes(): cycle guard
  return chain;
}

// "30 Days" / "30" -> 30; anything else -> null.
export const creditDaysOf = (s) => {
  const m = String(s ?? "").trim().match(/^(\d+)(\s*days?)?$/i);
  return m ? Number(m[1]) : null;
};

// Ledger name -> { group, email, debtor, retainer, balance, billWise, defaultCreditDays }.
//   balance: closing balance, receivable = positive (Tally sends debit as negative).
//   defaultCreditDays: the ledger's default credit period (Tally copies it onto new bills).
export async function getLedgers() {
  // Sequential on purpose: Tally's HTTP server handles one request at a time.
  const parents = await getGroupParents();
  const lx = await postXml(collectionRequest("L", "Ledger",
    ["Name", "Parent", "Email", "ClosingBalance", "IsBillWiseOn", "BillCreditPeriod"]));
  return new Map(
    [...lx.matchAll(/<LEDGER NAME="([^"]*)"[\s\S]*?<\/LEDGER>/g)].map(([l, name]) => {
      const group = decode(field(l, "PARENT"));
      const chain = groupChain(group, parents);
      const bw = field(l, "ISBILLWISEON").trim();
      const cpTag = l.match(/<BILLCREDITPERIOD\b[^>]*>(?:([^<]*)<)?/);
      return [decode(name), {
        group,
        email: decode(field(l, "EMAIL")),
        debtor: chain.includes(DEBTORS_GROUP),
        retainer: chain.includes(RETAINER_GROUP),
        balance: round2(-Number(field(l, "CLOSINGBALANCE") || 0)),
        billWise: bw === "Yes" ? true : bw === "No" ? false : null,
        defaultCreditDays: cpTag ? creditDaysOf(decode(attr(cpTag[0], "P") ?? cpTag[1] ?? "")) : null,
      }];
    }),
  );
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// The bill's own terms. <BILLDUEDATE JD="46173" P="30 Days">: JD = bill date (Tally day number),
// P = credit period as typed on the bill: "30 Days", a fixed date "15-Aug-2026", or empty.
// -> { billDate, creditDays, fixedDue } or { issue }. Fallbacks are applied later (resolveDueDate).
export function parseBillTerms(billXml) {
  const tag = billXml.match(/<BILLDUEDATE\b[^>]*>/)?.[0] ?? "";
  const jd = attr(tag, "JD");
  const billDate = jd ? fromJD(Number(jd)) : ymd(field(billXml, "BILLDATE"));
  const p = decode(attr(tag, "P") ?? "").trim();
  if (!p) return { billDate, creditDays: null, fixedDue: null };
  const days = creditDaysOf(p);
  if (days != null) return { billDate, creditDays: days, fixedDue: null };
  const m = p.match(/^(\d{1,2})-([a-z]{3})-(\d{2}|\d{4})$/i);
  if (m && m[2].toLowerCase() in MONTHS) {
    const y = Number(m[3]) + (m[3].length === 2 ? 2000 : 0);
    return { billDate, creditDays: null, fixedDue: new Date(Date.UTC(y, MONTHS[m[2].toLowerCase()], Number(m[1]))) };
  }
  return { issue: `unrecognised credit period "${p}" in Tally` };
}

// Everything the receivables views need, from 3 Tally requests (groups, ledgers, bills).
//   rows:      open DEBIT bills of customers, most overdue first (bills that can't be aged: last)
//   credits:   CREDIT-balance bill references of customers = advances / unadjusted credit notes
//   onAccount: customer -> ledger balance not linked to any bill (+ debit, − credit)
export async function loadReceivables(asOf = new Date(), { ledgers, config = CONFIG } = {}) {
  const day = toDateOnly(asOf);
  ledgers ??= await getLedgers();
  const bx = await postXml(collectionRequest("B", "Bill", ["Name", "Parent", "BillDate", "BillDueDate", "ClosingBalance"]));

  const rows = [];
  const credits = [];
  const billSum = new Map();
  for (const [b, attrName] of bx.matchAll(/<BILL NAME="([^"]*)"[\s\S]*?<\/BILL>/g)) {
    const customer = decode(field(b, "PARENT"));
    const led = ledgers.get(customer);
    if (!led?.debtor) continue; // only customers: supplier bills/advances are not receivables
    const amount = round2(-Number(field(b, "CLOSINGBALANCE") || 0)); // Tally: debit (receivable) is negative
    if (amount === 0) continue; // fully settled
    billSum.set(customer, round2((billSum.get(customer) ?? 0) + amount));
    const bill = decode(field(b, "NAME") || attrName);
    const billDate = field(b, "BILLDATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

    if (amount < 0) { credits.push({ bill, customer, billDate, amount: -amount }); continue; }

    const terms = parseBillTerms(b);
    const due = resolveDueDate(terms, led.defaultCreditDays, config.dueDateFallback);
    const bd = terms.billDate ?? (billDate ? new Date(billDate) : null);
    rows.push({
      bill,
      customer,
      retainer: led.retainer ? "yes" : "",
      billDate,
      dueDate: due.dueDate ? fmtDate(due.dueDate) : "",
      overdueDays: due.dueDate ? overdueDays(day, due.dueDate) : null,
      outstanding: amount,
      email: led.email ?? "",
      emailStatus: checkEmails(led.email).status,
      dueDateSource: due.source ?? null,
      daysSinceBill: bd ? daysBetween(bd, day) : null,
      ...(due.issue && { issue: due.issue }),
    });
  }

  const onAccount = new Map();
  for (const [name, led] of ledgers) {
    if (!led.debtor) continue;
    const v = round2(led.balance - (billSum.get(name) ?? 0));
    if (Math.abs(v) >= 0.01) onAccount.set(name, v);
  }

  rows.sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));
  return { asOf: day, ledgers, rows, credits, onAccount };
}

// Open debit bills only (the original API, kept for existing callers).
export async function getReceivables(asOf = new Date(), ledgers) {
  return (await loadReceivables(asOf, { ledgers })).rows;
}

// §6 Payment history per bill, rebuilt from voucher bill allocations (receipts, credit notes, journals
// against the bill). Read-only and heavier (reads all vouchers), so callers opt in.
// -> Map "customer\u0000bill" -> { billed, adjusted, adjustments: [{date, type, number, amount}] }
export async function getBillHistory(ledgers) {
  const vx = await postXml(collectionRequest("VH", "Voucher",
    ["Date", "VoucherTypeName", "VoucherNumber", "PartyLedgerName", "Amount"]));
  const hist = new Map();
  for (const [v] of vx.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)) {
    const date = field(v, "DATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const type = decode(field(v, "VOUCHERTYPENAME"));
    const number = decode(field(v, "VOUCHERNUMBER")).trim();
    // Accounting-view vouchers use ALLLEDGERENTRIES, item invoices use LEDGERENTRIES.
    for (const [e] of v.matchAll(/<((?:ALL)?LEDGERENTRIES)\.LIST>[\s\S]*?<\/\1\.LIST>/g)) {
      const ledger = decode(field(e, "LEDGERNAME"));
      if (!ledgers.get(ledger)?.debtor) continue;
      for (const [a] of e.matchAll(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g)) {
        const bill = decode(field(a, "NAME")).trim();
        const amt = Number(field(a, "AMOUNT") || 0);
        if (!bill || !amt) continue;
        const key = `${ledger}\u0000${bill}`;
        const h = hist.get(key) ?? { billed: 0, adjusted: 0, adjustments: [] };
        if (amt < 0) h.billed = round2(h.billed - amt); // debit: the invoice (or a debit adjustment)
        else {
          h.adjusted = round2(h.adjusted + amt);
          h.adjustments.push({ date, type, number, amount: round2(amt) });
        }
        hist.set(key, h);
      }
    }
  }
  return hist;
}

// Adds billed / adjusted / adjustments to each bill row, and flags rows where the voucher history
// doesn't add up to Tally's bill balance (opening-balance bills have no voucher: billed is null).
export function attachHistory(rows, hist) {
  return rows.map((r) => {
    const h = hist.get(`${r.customer}\u0000${r.bill}`);
    if (!h) return { ...r, billed: null, adjusted: null, adjustments: [], historyNote: "no voucher found (opening balance bill?)" };
    const fromHistory = round2(h.billed - h.adjusted);
    return { ...r, billed: h.billed, adjusted: h.adjusted, adjustments: h.adjustments,
      ...(Math.abs(fromHistory - r.outstanding) >= 0.01 && {
        historyNote: `vouchers give ₹${fromHistory}, Tally bill balance is ₹${r.outstanding}` }) };
  });
}
