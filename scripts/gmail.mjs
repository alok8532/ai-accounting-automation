// Gmail connection helper.
//   npm run gmail:auth        -> log in to your Gmail account in the browser (one time; again after expiry)
//   npm run gmail:status      -> show the connected account + granted permissions, and test a token refresh
//   npm run gmail:test-draft  -> put ONE test draft (to yourself, with a small PDF) into your Gmail Drafts
//   npm run gmail:revoke      -> disconnect: revoke the token at Google and delete it locally
// Nothing here can send an email.

import { login, revoke, getAccessToken, gmailConfig, connectedAccount, invalidateAccessToken } from "../lib/gmail/oauth.mjs";
import { createGmailDraft } from "../lib/gmail/client.mjs";
import { gmailDraftLink } from "../lib/gmail/links.mjs";

// A tiny one-page PDF, to check that attachments arrive intact.
function samplePdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 14 Tf 20 70 Td (Sample invoice attachment - test only) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const cmd = process.argv[2];
try {
  const cfg = gmailConfig();
  if (cmd === "auth") {
    console.log(`Connecting Gmail with permission: ${cfg.gmailScope}`);
    const r = await login();
    console.log(`\nConnected: ${r.account ?? "(email not returned)"}\nPermissions: ${r.scope.join(", ")}\nToken saved to: ${r.tokenFile}`);
  } else if (cmd === "status") {
    const acc = await connectedAccount();
    if (!acc) { console.log("Gmail is not connected. Run: npm run gmail:auth"); process.exit(1); }
    invalidateAccessToken();
    await getAccessToken(); // forces a refresh: proves the stored login still works
    console.log(`Gmail connected:  ${acc.account ?? "(unknown email)"}`);
    console.log(`Connected at:     ${acc.connectedAt}`);
    console.log(`Permissions:      ${acc.scope}`);
    console.log(`Token refresh:    OK`);
    console.log(`Token file:       ${cfg.tokenFile}`);
    console.log(`Sending emails:   NOT POSSIBLE in this app (only draft creation is allowed in code)` +
      (cfg.mode === "insert" ? "; the gmail.insert permission itself cannot send either." : "."));
  } else if (cmd === "test-draft") {
    const acc = await connectedAccount();
    if (!acc?.account) throw new Error("Gmail is not connected (or the account email is unknown). Run: npm run gmail:auth");
    const text = [
      "Dear Test Customer Accounts Team,",
      "",
      "This is a TEST draft created by the AI Accountant POC. It was not sent. Please delete it.",
      "",
      "Invoice TEST-001 | Dated 01-Oct-2026 | Due 31-Oct-2026 | Balance ₹59,000",
      "Invoice TEST-002 | Dated 02-Oct-2026 | Due 01-Nov-2026 | Balance ₹23,600",
      "Total balance due: ₹82,600",
      "",
      "Regards,",
      "Accounts Team",
    ].join("\n");
    const r = await createGmailDraft({
      to: acc.account, subject: "[TEST] AI Accountant – Gmail draft test (safe to delete)", text,
      attachments: [{ filename: "TEST-invoice.pdf", contentType: "application/pdf", content: samplePdf() }],
    });
    console.log("Test draft created:", r);
    console.log("Open it directly:", gmailDraftLink(r.gmailMessageId, acc.account));
    console.log("Open Gmail -> Drafts. Check: it is there, opens as an editable draft, shows the table, and has TEST-invoice.pdf.");
  } else if (cmd === "revoke") {
    const r = await revoke();
    console.log(r.revoked ? `Disconnected ${r.account ?? ""}${r.atGoogle ? "" : " (local token deleted; Google could not be reached — also remove access at https://myaccount.google.com/permissions)"}` : r.message);
  } else {
    console.log("Usage: node scripts/gmail.mjs auth|status|test-draft|revoke");
    process.exit(2);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
