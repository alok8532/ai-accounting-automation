// Minimal TallyPrime XML/HTTP client shared by all scripts.
// Tally is the system of record; this module only talks to it over localhost.

export const TALLY_URL = process.env.TALLY_URL ?? "http://localhost:9000";
export const COMPANY = process.env.TALLY_COMPANY ?? "Demo Trading Co";

// Escape text we put INTO XML (customer names like "A & B" would break the request otherwise).
export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Decode text we read OUT of Tally's XML.
export const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;|&#10;/g, " ")
   .replace(/&#4;\s*/g, ""); // Tally's internal marker for built-in groups like "Primary"

// A frozen Tally (modal dialog open, big report running) must not hang Claude forever.
export const TIMEOUT_MS = Number(process.env.TALLY_TIMEOUT_MS ?? 15000);

// Every HTTP call to Tally goes through here, so all of them get the timeout.
export async function tallyFetch(init = {}) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(TALLY_URL, { ...init, signal });
    if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
    return await res.text(); // read the body inside the try: a stall mid-body is a timeout too
  } catch (e) {
    if (signal.aborted) throw new Error(`Tally did not respond within ${TIMEOUT_MS / 1000}s`);
    throw e;
  }
}

export const postXml = (xml) =>
  tallyFetch({ method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: xml });

// READ: inline TDL collection — "every object of TYPE, with these fields".
export function collectionRequest(name, type, fields, { from, to } = {}) {
  const dates = from ? `<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE>` : "";
  return `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${name}</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY>${dates}
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="${name}" ISMODIFY="No"><TYPE>${type}</TYPE>
        ${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
}

// WRITE: import masters ("All Masters") or vouchers ("Vouchers") into the named company.
export async function importData(reportName, tallyMessagesXml) {
  const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC>
      <REPORTNAME>${reportName}</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${tallyMessagesXml}</TALLYMESSAGE></REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`;
  const res = await postXml(xml);
  const num = (tag) => Number((res.match(new RegExp(`<${tag}>(\\d+)</${tag}>`)) ?? [])[1] ?? 0);
  return {
    created: num("CREATED"),
    altered: num("ALTERED"),
    errors: num("ERRORS"),
    lineErrors: [...res.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/g)].map((m) => decode(m[1])),
    raw: res,
  };
}
