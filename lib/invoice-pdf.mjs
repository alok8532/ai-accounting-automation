// Invoice PDF from Tally (read-only Export).
// Tally's XML interface cannot return a PDF directly, so:
//   1. ask Tally for its own "Printed Invoice" report of ONE voucher (by MasterID) as HTML,
//   2. clean the HTML (Tally labels it utf-16 but sends utf-8; drop the "Accounting Voucher Display" title bar;
//      scale it to fit an A4 page),
//   3. print it to PDF with Microsoft Edge in headless mode (installed on every Windows 10/11 PC).
// The PDF therefore shows exactly what Tally would print for that voucher.

import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tallyFetch, esc, COMPANY } from "./tally.mjs";

const run = promisify(execFile);

const EDGE_PATHS = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

export function invoiceHtmlRequest(masterId) {
  if (!/^\d+$/.test(String(masterId).trim())) throw new Error(`Invalid Tally MasterID "${masterId}"`);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>AIInvoicePrint</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:HTML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><REPORT NAME="AIInvoicePrint" ISMODIFY="No"><USE>Printed Invoice</USE><OBJECTS>Voucher : "ID:${String(masterId).trim()}"</OBJECTS></REPORT></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export function cleanInvoiceHtml(html) {
  if (!/<HTML/i.test(html)) throw new Error("Tally did not return an invoice (no HTML in the response)");
  return html
    .replace(/<HTML[^>]*>/i, "<HTML>")
    .replace(/<TABLE[^>]*bgcolor="#2a67b1"[^>]*>[\s\S]*?<\/TABLE>/i, "") // "Accounting Voucher Display" title bar
    .replace(/<HEAD>/i, '<HEAD><META charset="utf-8"><style>@page{size:A4;margin:10mm} body{zoom:0.48}</style>');
}

// Replaceable in tests (no Edge in CI).
export const renderer = {
  async htmlToPdf(htmlFile, pdfFile) {
    const edge = EDGE_PATHS.find((p) => existsSync(p));
    if (!edge) throw new Error("Microsoft Edge not found (set EDGE_PATH in .env to msedge.exe)");
    await run(edge, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfFile}`,
      pathToFileURL(htmlFile).href], { timeout: 60000, windowsHide: true });
  },
};

// Writes the invoice PDF of Tally voucher `masterId` to `pdfFile`. Returns the file path.
export async function exportInvoicePdf({ masterId, pdfFile }) {
  const html = cleanInvoiceHtml(await tallyFetch({
    method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: invoiceHtmlRequest(masterId),
  }));
  const tmp = join(tmpdir(), `invoice-${randomBytes(6).toString("hex")}.html`);
  await writeFile(tmp, html, "utf8");
  try {
    await mkdir(dirname(pdfFile), { recursive: true });
    await renderer.htmlToPdf(tmp, pdfFile);
    if (!(await stat(pdfFile).catch(() => null))?.size) throw new Error("PDF was not created");
    return pdfFile;
  } finally {
    await rm(tmp, { force: true });
  }
}
