// Bill-wise receivables, shared by scripts/check-outstanding.mjs and the MCP server.
// Read-only: only Export requests are sent to Tally.

import { postXml, collectionRequest, decode } from "./tally.mjs";

const DAY = 86400000;
const fromJD = (jd) => new Date(Date.UTC(1899, 11, 31) + jd * DAY);
export const fmtDate = (d) => d.toISOString().slice(0, 10);

export const field = (block, tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]*)<`)) ?? [])[1] ?? "";

// Ledger name -> { group, email }
export async function getLedgers() {
  const lx = await postXml(collectionRequest("L", "Ledger", ["Name", "Parent", "Email"]));
  return new Map(
    [...lx.matchAll(/<LEDGER NAME="([^"]*)"[\s\S]*?<\/LEDGER>/g)].map((m) => [
      decode(m[1]), { group: decode(field(m[0], "PARENT")), email: decode(field(m[0], "EMAIL")) },
    ]),
  );
}

// Open receivable bills, most overdue first.
export async function getReceivables(asOf = new Date()) {
  const ledgers = await getLedgers();
  const bx = await postXml(collectionRequest("B", "Bill", ["Name", "Parent", "BillDate", "BillDueDate", "ClosingBalance"]));
  const rows = [...bx.matchAll(/<BILL NAME="[^"]*"[\s\S]*?<\/BILL>/g)].map(([b]) => {
    const due = b.match(/<BILLDUEDATE[^>]*JD="(\d+)"[^>]*P="(\d*)/);
    const dueDate = fromJD(Number(due[1]) + Number(due[2] || 0)); // JD = bill date, P = credit days
    const balance = -Number(field(b, "CLOSINGBALANCE")); // Tally: debit (receivable) is negative
    const party = decode(field(b, "PARENT"));
    return {
      bill: decode(field(b, "NAME")),
      customer: party,
      retainer: ledgers.get(party)?.group === "Retainer Customers" ? "yes" : "",
      billDate: field(b, "BILLDATE").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
      dueDate: fmtDate(dueDate),
      overdueDays: Math.max(0, Math.floor((asOf - dueDate) / DAY)),
      outstanding: balance,
      email: ledgers.get(party)?.email ?? "",
    };
  }).filter((r) => r.outstanding > 0);

  rows.sort((a, b) => b.overdueDays - a.overdueDays);
  return rows;
}
