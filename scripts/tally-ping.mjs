// Step 1: TallyPrime XML/HTTP connectivity test (read-only).
// Usage: node scripts/tally-ping.mjs
// No dependencies — uses Node 22's built-in fetch.

const TALLY_URL = process.env.TALLY_URL ?? "http://localhost:9000";

// Tally returns XML-escaped text; decode the common entities.
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;|&#10;/g, " ")
   .replace(/&#4;\s*/g, ""); // Tally's internal marker for built-in groups like "Primary"

async function postXml(xml) {
  const res = await fetch(TALLY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xml,
  });
  if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
  return res.text();
}

// An inline TDL collection: "give me every object of TYPE X, with these fields".
// This is an Export request — it only reads data, nothing is written to Tally.
const collectionRequest = (name, type, fields) => `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${name}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      <TDL><TDLMESSAGE>
        <COLLECTION NAME="${name}" ISMODIFY="No">
          <TYPE>${type}</TYPE>
          ${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
        </COLLECTION>
      </TDLMESSAGE></TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

async function main() {
  // 1. Is the Tally HTTP server up?
  const ping = await (await fetch(TALLY_URL)).text();
  console.log("1) Server check :", ping.replace(/<[^>]+>/g, "").trim());

  // 2. Which company is loaded?
  const companyXml = await postXml(collectionRequest("CompanyList", "Company", ["Name"]));
  const companies = [...companyXml.matchAll(/<COMPANY NAME="([^"]*)"/g)].map((m) => decode(m[1]));
  console.log("2) Open company :", companies.length ? companies.join(", ") : "(none — open a company in Tally)");

  // 3. List ledgers with their parent group.
  const ledgerXml = await postXml(collectionRequest("LedgerList", "Ledger", ["Name", "Parent"]));
  const ledgers = [...ledgerXml.matchAll(/<LEDGER NAME="([^"]*)"[\s\S]*?<PARENT[^>]*>([^<]*)<\/PARENT>/g)]
    .map((m) => ({ ledger: decode(m[1]), group: decode(m[2]) }));
  console.log(`3) Ledgers found: ${ledgers.length}`);
  console.table(ledgers);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  console.error("Check: Tally is open, a company is loaded, and port 9000 is enabled.");
  process.exit(1);
});
