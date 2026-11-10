// A tiny fake TallyPrime HTTP server for tests: answers the inline-TDL collection Export requests
// our code sends (Company, Group, Ledger, Bill, Voucher) with XML in the same shape TallyPrime returns.
// No real Tally, no network beyond 127.0.0.1. Import (write) requests are refused unless
// startFakeTally({ allowImport: true }): then Sales vouchers are stored like Tally would (state.importMode
// "ok" | "reject" | "fail" (HTTP 500) | "phantom" (says created, stores nothing)). The "Printed Invoice"
// HTML export answers with a small fake invoice page.

import { createServer } from "node:http";

const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Tally day number: days since 31-Dec-1899.
export const jd = (ymd) => Math.round((Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - Date.UTC(1899, 11, 31)) / 86400000);

// Demo-like data (mirrors scripts/seed-demo-data.mjs). Mutate `state` in a test to change what "Tally" returns.
// Amounts use Tally's sign convention: debit (receivable) negative, credit positive.
export function demoState() {
  return {
    company: "Demo Trading Co",
    groups: [
      { name: "Primary" }, // built-in groups come back with "&#4; Primary" as parent
      { name: "Current Assets", parent: "&#4; Primary" },
      { name: "Current Liabilities", parent: "&#4; Primary" },
      { name: "Sundry Debtors", parent: "Current Assets" },
      { name: "Sundry Creditors", parent: "Current Liabilities" },
      { name: "Retainer Customers", parent: "Sundry Debtors" },
      { name: "Retainer Customers - North", parent: "Retainer Customers" }, // nested sub-group
    ],
    // credit: ledger default credit period (days). onAccount: amount not linked to any bill (Tally sign).
    ledgers: [
      { name: "Sharma Exports Pvt Ltd", parent: "Retainer Customers", email: "accounts@sharma-exports.example.com", credit: 15 },
      { name: "Gupta Healthcare", parent: "Retainer Customers - North", email: "finance@gupta-health.example.com", credit: 30 },
      { name: "Verma Textiles", parent: "Retainer Customers", email: "billing@verma-textiles.example.com", credit: 30, onAccount: 20000 },
      { name: "Kapoor Builders", parent: "Sundry Debtors", email: "accounts@kapoor-builders.example.com", credit: 30 },
      { name: "Singh Logistics", parent: "Sundry Debtors", email: "ap@singh-logistics.example.com", credit: 45 },
      { name: "Mehta Retail", parent: "Sundry Debtors", email: "", credit: 30 },
      { name: "A & B Traders", parent: "Sundry Debtors", email: "ab@ab.example.com" },
      { name: "A-B Traders", parent: "Sundry Debtors", email: "ab2@ab.example.com" },
      { name: "Paper Supplier", parent: "Sundry Creditors", email: "sales@paper.example.com" },
      { name: "Consulting Income", parent: "Sales Accounts" },
      { name: "Output CGST 9%", parent: "Duties & Taxes" },
      { name: "Output SGST 9%", parent: "Duties & Taxes" },
    ],
    // p: credit period on the bill (BILLDUEDATE P attribute).
    bills: [
      { name: "DEMO-001", party: "Kapoor Builders", date: "2026-06-01", p: "30 Days", balance: -59000 },
      { name: "DEMO-009", party: "Kapoor Builders", date: "2026-10-02", p: "30 Days", balance: -17700 }, // 23,600 − credit note 5,900
      { name: "DEMO-002", party: "Singh Logistics", date: "2026-07-01", p: "45 Days", balance: -64400 }, // part-paid
      { name: "DEMO-006", party: "Sharma Exports Pvt Ltd", date: "2026-09-01", p: "15 Days", balance: -29500 },
      { name: "DEMO-003", party: "Sharma Exports Pvt Ltd", date: "2026-08-01", p: "15 Days", balance: 0 }, // fully paid
      { name: "DEMO-005", party: "Gupta Healthcare", date: "2026-09-01", p: "30 Days", balance: -47200 },
      { name: "CN-GUPTA-01", party: "Gupta Healthcare", date: "2026-11-01", p: "", balance: 2360 }, // unadjusted credit note
      { name: "DEMO-007", party: "Verma Textiles", date: "2026-10-01", p: "30 Days", balance: -17700 },
      { name: "DEMO-004", party: "Mehta Retail", date: "2026-08-02", p: "30 Days", balance: -14160 },
      { name: "ADV-MEHTA-01", party: "Mehta Retail", date: "2026-11-01", p: "", balance: 5000 }, // advance
      { name: "1", party: "A & B Traders", date: "2026-09-01", p: "30 Days", balance: -1000 },
      { name: "1", party: "A-B Traders", date: "2026-09-01", p: "30 Days", balance: -2000 }, // same bill no., other party
      { name: "ADV-1", party: "Paper Supplier", date: "2026-09-01", p: "", balance: -5000 }, // supplier advance (debit)
    ],
    // Vouchers with bill allocations (for payment history). allocs: [ledger, bill, amount].
    vouchers: [
      { date: "2026-06-01", type: "Sales", number: "11", allocs: [["Kapoor Builders", "DEMO-001", -59000]] },
      { date: "2026-07-01", type: "Sales", number: "12", allocs: [["Singh Logistics", "DEMO-002", -94400]] },
      { date: "2026-08-01", type: "Receipt", number: "DEMO-R02", allocs: [["Singh Logistics", "DEMO-002", 30000]] },
      { date: "2026-10-02", type: "Sales", number: "19", allocs: [["Kapoor Builders", "DEMO-009", -23600]], invoice: true },
      { date: "2026-11-02", type: "Credit Note", number: "DEMO-CN1", allocs: [["Kapoor Builders", "DEMO-009", 5900]] },
      { date: "2026-09-01", type: "Sales", number: "15", allocs: [["Gupta Healthcare", "DEMO-005", -40000]] }, // deliberately wrong
    ],
  };
}

const groupXml = (g) => `<GROUP NAME="${x(g.name)}" RESERVEDNAME=""><PARENT TYPE="String">${g.parent ?? ""}</PARENT></GROUP>`;
function ledgerXml(l, bills) {
  const closing = bills.filter((b) => b.party === l.name).reduce((s, b) => s + b.balance, 0) + (l.onAccount ?? 0);
  const cp = l.credit ? `<BILLCREDITPERIOD TYPE="Due Date" P="${l.credit} Days">${l.credit} Days</BILLCREDITPERIOD>` : "";
  return `<LEDGER NAME="${x(l.name)}" RESERVEDNAME=""><PARENT TYPE="String">${x(l.parent)}</PARENT>` +
    `<EMAIL TYPE="String">${x(l.email ?? "")}</EMAIL><CLOSINGBALANCE TYPE="Amount">${closing.toFixed(2)}</CLOSINGBALANCE>` +
    `<ISBILLWISEON TYPE="Logical">${l.billWise === false ? "No" : "Yes"}</ISBILLWISEON>${cp}</LEDGER>`;
}
function billXml(b) {
  const due = b.rawDue ?? // tests can supply an odd BILLDUEDATE tag verbatim
    `<BILLDUEDATE TYPE="Due Date" JD="${jd(b.date)}" P="${x(b.p)}">${x(b.p)}</BILLDUEDATE>`;
  return `<BILL NAME="${x(b.name)}" RESERVEDNAME=""><NAME TYPE="String">${x(b.name)}</NAME>` +
    `<PARENT TYPE="String">${x(b.party)}</PARENT><BILLDATE TYPE="Date">${b.date.replaceAll("-", "")}</BILLDATE>` +
    `${due}<CLOSINGBALANCE TYPE="Amount">${b.balance.toFixed(2)}</CLOSINGBALANCE></BILL>`;
}
function voucherXml(v) {
  const tag = v.invoice ? "LEDGERENTRIES" : "ALLLEDGERENTRIES"; // item invoices use LEDGERENTRIES.LIST
  const entries = v.allocs.map(([ledger, bill, amt]) => `<${tag}.LIST><LEDGERNAME>${x(ledger)}</LEDGERNAME>` +
    `<AMOUNT>${amt.toFixed(2)}</AMOUNT><BILLALLOCATIONS.LIST><NAME>${x(bill)}</NAME><BILLTYPE>x</BILLTYPE>` +
    `<AMOUNT>${amt.toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST></${tag}.LIST>`).join("") +
    (v.other ?? []).map(([ledger, amt]) => `<${tag}.LIST><LEDGERNAME>${x(ledger)}</LEDGERNAME><AMOUNT>${amt.toFixed(2)}</AMOUNT></${tag}.LIST>`).join("");
  return `<VOUCHER REMOTEID="r" VCHTYPE="${x(v.type)}"><DATE TYPE="Date">${v.date.replaceAll("-", "")}</DATE>` +
    (v.narration ? `<NARRATION TYPE="String">${x(v.narration)}</NARRATION>` : "") +
    `<VOUCHERTYPENAME>${x(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${x(v.number)}</VOUCHERNUMBER>` +
    `<PARTYLEDGERNAME>${x(v.allocs[0][0])}</PARTYLEDGERNAME>` +
    (v.masterId ? `<MASTERID TYPE="Number"> ${v.masterId}</MASTERID>` : "") + `${entries}</VOUCHER>`;
}

const un = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const tagv = (b, t) => un((b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1] ?? "");

// Import of Sales vouchers, stored the way the Export side returns them.
function importVouchers(body, state) {
  if (state.importMode === "reject") return { created: 0, errors: 1, lineErrors: ["Voucher totals do not match!"] };
  const vouchers = [...body.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map(([v]) => v);
  state.imports.push(...vouchers);
  if (state.importMode === "phantom") return { created: vouchers.length, errors: 0, lineErrors: [] };
  for (const v of vouchers) {
    const entries = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g)].map(([e]) => e);
    const party = tagv(v, "PARTYLEDGERNAME");
    const pe = entries.find((e) => tagv(e, "LEDGERNAME") === party);
    const bill = tagv(pe, "NAME");
    const amount = Number(tagv(pe, "AMOUNT"));
    const date = tagv(v, "DATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    state.vouchers.push({ date, type: tagv(v, "VOUCHERTYPENAME"), number: String(state.nextVoucherNumber++),
      narration: tagv(v, "NARRATION"), masterId: state.nextMasterId++, allocs: [[party, bill, amount]],
      other: entries.filter((e) => e !== pe).map((e) => [tagv(e, "LEDGERNAME"), Number(tagv(e, "AMOUNT"))]) });
    state.bills.push({ name: bill, party, date, p: (v.match(/<BILLCREDITPERIOD[^>]*P="([^"]*)"/) ?? [])[1] ?? "", balance: amount });
  }
  return { created: vouchers.length, errors: 0, lineErrors: [] };
}

const envelope = (inner) => `<ENVELOPE><BODY><DESC></DESC><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;

// Starts the fake server. Returns { url, state, requests, close }.
// opts.hang = true: accept connections but never answer (for timeout tests).
export async function startFakeTally({ state = demoState(), hang = false, allowImport = false } = {}) {
  Object.assign(state, { importMode: "ok", imports: [], nextVoucherNumber: 21, nextMasterId: 100, ...state });
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (hang) return;
      requests.push(body);
      if (req.method === "GET") return res.end("<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      if (/<TALLYREQUEST>\s*Import/i.test(body)) {
        if (!allowImport) { res.statusCode = 403; return res.end("writes not allowed in tests"); }
        if (state.importMode === "fail") { res.statusCode = 500; return res.end("Tally crashed"); }
        const r = importVouchers(body, state);
        return res.end(`<RESPONSE><CREATED>${r.created}</CREATED><ALTERED>0</ALTERED><ERRORS>${r.errors}</ERRORS>` +
          r.lineErrors.map((l) => `<LINEERROR>${x(l)}</LINEERROR>`).join("") + "</RESPONSE>");
      }
      if (/<USE>Printed Invoice<\/USE>/.test(body)) {
        const id = body.match(/ID:(\d+)/)?.[1];
        const v = state.vouchers.find((q) => String(q.masterId) === id);
        if (!v) return res.end("<ENVELOPE><LINEERROR>Voucher not found</LINEERROR></ENVELOPE>");
        return res.end(`<HTML charset="utf-16"><HEAD></HEAD><BODY><TABLE bgcolor="#2a67b1"><TR><TH>Accounting Voucher Display</TH></TR></TABLE>` +
          `<P>Invoice ${x(v.number)} for ${x(v.allocs[0][0])} total ${(-v.allocs[0][2]).toFixed(2)}</P></BODY></HTML>`);
      }
      const type = body.match(/<TYPE>(\w+)<\/TYPE>\s*(<NATIVEMETHOD|<\/COLLECTION)/)?.[1];
      const items = {
        Company: () => [`<COMPANY NAME="${x(state.company)}"></COMPANY>`],
        Group: () => state.groups.map(groupXml),
        Ledger: () => state.ledgers.map((l) => ledgerXml(l, state.bills)),
        Bill: () => state.bills.map(billXml),
        Voucher: () => state.vouchers.map(voucherXml),
      }[type];
      if (!items) { res.statusCode = 400; return res.end(`fake tally: unknown collection type ${type}`); }
      res.setHeader("Content-Type", "text/xml; charset=utf-8");
      res.end(envelope(items().join("")));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
