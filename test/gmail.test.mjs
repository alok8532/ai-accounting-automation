import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeGoogle } from "./fake-google.mjs";

let g, tmp, oauth, client, mime;
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const INSERT = "https://www.googleapis.com/auth/gmail.insert";
const ID = "openid https://www.googleapis.com/auth/userinfo.email";

before(async () => {
  g = await startFakeGoogle();
  tmp = await mkdtemp(join(tmpdir(), "gmail-test-"));
  Object.assign(process.env, {
    DOTENV_FILE: join(tmp, "no.env"), GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret",
    GMAIL_SCOPE: "compose", GMAIL_TOKEN_FILE: join(tmp, "tok", "gmail-token.json"),
    GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: g.url,
  });
  oauth = await import("../lib/gmail/oauth.mjs");
  client = await import("../lib/gmail/client.mjs");
  mime = await import("../lib/mime.mjs");
});
after(async () => { await g.close(); await rm(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  Object.assign(g.state, { requests: [], refreshError: null, gmailStatus: 200, drafts: [], grantedScope: `${COMPOSE} ${ID}` });
  g.state.rejectTokens.clear();
  process.env.GMAIL_SCOPE = "compose";
  oauth.invalidateAccessToken();
});

// Simulates the user clicking "Allow" in the browser: hit the loopback redirect with the code.
const userApproves = (url) => {
  const u = new URL(url);
  fetch(`${u.searchParams.get("redirect_uri")}/?code=abc&state=${u.searchParams.get("state")}`);
};
const connect = () => oauth.login({ open: userApproves, log: () => {} });
const sample = { to: "cust@example.com", subject: "Payment reminder: Invoice DEMO-001 – ₹59,000 due",
  text: "Dear X,\n\nInvoice DEMO-001 | Dated 01-Jun-2026 | Due 01-Jul-2026 | Balance ₹59,000\n\nRegards" };

// ---------- 1. authentication ----------

test("login: PKCE + loopback, stores refresh token outside the repo with only the allowed scopes", async () => {
  const r = await connect();
  assert.equal(r.account, "me@example.com");
  const authReq = g.state.requests.find((q) => q.path === "/token");
  const p = new URLSearchParams(authReq.body);
  assert.equal(p.get("grant_type"), "authorization_code");
  assert.ok(p.get("code_verifier"), "PKCE verifier sent");
  assert.match(p.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+$/);
  const saved = JSON.parse(await readFile(process.env.GMAIL_TOKEN_FILE, "utf8"));
  assert.equal(saved.refresh_token, "refresh-1");
  assert.equal(saved.gmail_scope, COMPOSE);
  assert.ok(!("access_token" in saved), "access token is never written to disk");
});

test("login asks Google for one Gmail scope only — never send/modify/full access", async () => {
  let asked;
  await oauth.login({ open: (url) => { asked = new URL(url).searchParams.get("scope"); userApproves(url); }, log: () => {} });
  assert.deepEqual(asked.split(" ").sort(), [COMPOSE, "email", "openid"].sort());
});

test("refuses a login where Google granted extra permissions", async () => {
  g.state.grantedScope = `${COMPOSE} https://www.googleapis.com/auth/gmail.send ${ID}`;
  await assert.rejects(connect(), /more access than allowed.*gmail\.send/);
});

test("refuses a login where the Gmail permission was not ticked", async () => {
  g.state.grantedScope = ID;
  await assert.rejects(connect(), /was not granted/);
});

test("missing client credentials gives a setup message", async () => {
  const keep = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try { await assert.rejects(oauth.getAccessToken(), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/); }
  finally { process.env.GOOGLE_CLIENT_SECRET = keep; }
});

// ---------- 2. token expiry / refresh ----------

test("access token is cached, then refreshed when it is about to expire", async () => {
  await connect();
  oauth.invalidateAccessToken();
  let t = 0;
  const now = () => t;
  const a = await oauth.getAccessToken({ now });
  assert.equal(await oauth.getAccessToken({ now }), a, "cached");
  t = 3599 * 1000 - 30000; // 30 s before expiry
  assert.notEqual(await oauth.getAccessToken({ now }), a, "refreshed");
});

test("expired access token (401 from Gmail) -> refreshed once and the draft is still created", async () => {
  await connect();
  g.state.rejectTokens.add(await oauth.getAccessToken());
  const r = await client.createGmailDraft(sample);
  assert.equal(r.gmailDraftId, "d1");
  assert.equal(g.state.drafts.length, 1);
});

test("expired / revoked refresh token -> clear 're-login' message", async () => {
  await connect();
  oauth.invalidateAccessToken();
  g.state.refreshError = "invalid_grant";
  await assert.rejects(oauth.getAccessToken(), /expired or was revoked.*npm run gmail:auth/);
});

test("switching GMAIL_SCOPE requires a new login", async () => {
  await connect();
  oauth.invalidateAccessToken();
  process.env.GMAIL_SCOPE = "insert";
  await assert.rejects(oauth.getAccessToken(), /GMAIL_SCOPE is now insert/);
});

// ---------- 3. draft creation ----------

test("compose mode: drafts.create with an HTML + text message", async () => {
  await connect();
  const r = await client.createGmailDraft(sample);
  assert.deepEqual(r, { gmailDraftId: "d1", gmailMessageId: "0a1b2c3d4e5f6001", gmailThreadId: "1a1b2c3d4e5f6001", gmailMode: "compose" });
  assert.equal(g.state.drafts[0].path, "/gmail/v1/users/me/drafts");
  assert.match(g.state.drafts[0].raw, /^To: cust@example\.com\r\n/);
  assert.match(g.state.drafts[0].raw, /multipart\/alternative/);
});

test("insert mode: messages.insert with the DRAFT label", async () => {
  process.env.GMAIL_SCOPE = "insert";
  g.state.grantedScope = `${INSERT} ${ID}`;
  await connect();
  const r = await client.createGmailDraft(sample);
  assert.equal(r.gmailMode, "insert");
  assert.equal(g.state.drafts[0].path, "/gmail/v1/users/me/messages");
  assert.deepEqual(g.state.drafts[0].labelIds, ["DRAFT"]);
});

test("Gmail API failure -> GmailApiError, no automatic retry of the POST", async () => {
  await connect();
  g.state.gmailStatus = 500;
  await assert.rejects(client.createGmailDraft(sample), (e) => e instanceof client.GmailApiError && e.status === 500 && /backendError/.test(e.message));
  assert.equal(g.state.requests.filter((q) => q.path.startsWith("/gmail/")).length, 1);
});

test("header injection in recipient or subject is refused", async () => {
  await connect();
  await assert.rejects(client.createGmailDraft({ ...sample, to: "a@b.com\r\nBcc: evil@x.com" }), /Line breaks/);
  await assert.rejects(client.createGmailDraft({ ...sample, subject: "Hi\nBcc: evil@x.com" }), /Line breaks/);
  assert.equal(g.state.drafts.length, 0);
});

// ---------- 4. sending is technically unavailable ----------

test("the API gate blocks every send / non-draft endpoint", () => {
  for (const mode of ["compose", "insert"]) {
    for (const [m, p] of [["POST", "/gmail/v1/users/me/messages/send"], ["POST", "/gmail/v1/users/me/drafts/send"],
      ["POST", "/gmail/v1/users/me/messages/import"], ["DELETE", "/gmail/v1/users/me/drafts/d1"], ["GET", "/gmail/v1/users/me/messages"],
      ["POST", "/gmail/v1/users/me/settings/forwardingAddresses"], ["POST", "/upload/gmail/v1/users/me/messages/send"]]) {
      assert.throws(() => client.assertAllowed(m, p, {}, mode), client.GmailBlockedError, `${mode} ${m} ${p}`);
    }
  }
  assert.throws(() => client.assertAllowed("POST", "/gmail/v1/users/me/drafts", {}, "insert"), client.GmailBlockedError);
  assert.throws(() => client.assertAllowed("POST", "/gmail/v1/users/me/messages", {}, "compose"), client.GmailBlockedError);
  assert.doesNotThrow(() => client.assertAllowed("POST", "/gmail/v1/users/me/drafts", {}, "compose"));
});

test("source code: no send / reply / forward Gmail calls anywhere in lib/, mcp/, scripts/", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const dir of ["lib", "lib/gmail", "mcp", "scripts"]) {
    for (const f of (await readdir(join(root, dir))).filter((f) => f.endsWith(".mjs"))) {
      const src = (await readFile(join(root, dir, f), "utf8")).replace(/(^|\s)\/\/.*$/gm, ""); // code only, not comments
      assert.doesNotMatch(src, /(messages|drafts)\/send|gmail\.send|mail\.google\.com\/?["'`]/, `${dir}/${f}`);
    }
  }
});

test("only exported Gmail operation is draft creation", () => {
  assert.deepEqual(Object.keys(client).filter((k) => typeof client[k] === "function" && !/Error$/.test(k)).sort(),
    ["assertAllowed", "createGmailDraft"]);
});

// ---------- 5. MIME: HTML formatting + attachments ----------

const decodeParts = (raw) => [...raw.matchAll(/Content-Type: ([^;\r\n]+)[^\r\n]*\r\n(?:[^\r\n]+\r\n)*?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?=--)/g)]
  .map(([, type, b64]) => ({ type, content: Buffer.from(b64.replace(/\r\n/g, ""), "base64") }));

test("HTML: escaped, paragraphs kept, bill lines become a table; text part unchanged", () => {
  const text = "Dear <Acme> & Co,\n\nInvoice DEMO-001 | Dated 01-Jun-2026 | Due 01-Jul-2026 | Balance ₹59,000\nTotal balance due: ₹59,000\n\nRegards,\nAccounts";
  const html = mime.textToHtml(text);
  assert.match(html, /Dear &lt;Acme&gt; &amp; Co,/);
  assert.match(html, /<table[^>]*><tr><td[^>]*>Invoice DEMO-001<\/td><td[^>]*>Dated 01-Jun-2026<\/td>/);
  assert.match(html, /<p[^>]*>Total balance due: ₹59,000<\/p>/);
  assert.match(html, /Regards,<br>Accounts/);
  assert.doesNotMatch(mime.textToHtml("<script>alert(1)</script>"), /<script>/);

  const parts = decodeParts(mime.buildMessage({ to: "a@b.com", subject: "s", text }));
  assert.equal(parts[0].type, "text/plain");
  assert.equal(parts[0].content.toString("utf8"), text.replace(/\n/g, "\r\n"));
  assert.equal(parts[1].type, "text/html");
});

test("non-ASCII subject is RFC 2047 encoded and round-trips", () => {
  const subject = "Payment reminder: Invoice DEMO-001 – ₹2,14,260 due (45 days overdue) for Sharma Exports Pvt Ltd";
  const raw = mime.buildMessage({ to: "a@b.com", subject, text: "x" });
  const header = raw.match(/Subject: ([^]*?)\r\n(?! )/)[1];
  for (const line of header.split("\r\n ")) assert.ok(line.length <= 75);
  const decoded = [...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], "base64")).reduce((a, b) => Buffer.concat([a, b]));
  assert.equal(decoded.toString("utf8"), subject);
});

test("PDF attachment: multipart/mixed, bytes intact; bad attachments refused", () => {
  const pdf = Buffer.from("%PDF-1.4\n\x00\xff binary bytes", "latin1");
  const raw = mime.buildMessage({ to: "a@b.com", subject: "s", text: "body",
    attachments: [{ filename: "Invoice DEMO-001.pdf", contentType: "application/pdf", content: pdf }] });
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Disposition: attachment; filename="Invoice DEMO-001\.pdf"/);
  assert.deepEqual(decodeParts(raw).find((p) => p.type === "application/pdf").content, pdf);
  const bad = (a) => () => mime.buildMessage({ to: "a@b.com", subject: "s", text: "b", attachments: [{ contentType: "application/pdf", content: pdf, ...a }] });
  assert.throws(bad({ filename: "../x.pdf" }), /Invalid attachment filename/);
  assert.throws(bad({ filename: "x.pdf\r\nBcc: e@x.com" }), /Line breaks/);
  assert.throws(bad({ filename: "x.pdf", content: "not a buffer" }), /must be a Buffer/);
  assert.throws(() => mime.buildMessage({ to: "a@b.com", subject: "s", text: "b",
    attachments: [{ filename: "big.pdf", contentType: "application/pdf", content: Buffer.alloc(21 * 1024 * 1024) }] }), /too large/);
});

test("revoke deletes the local token", async () => {
  await connect();
  const r = await oauth.revoke();
  assert.equal(r.revoked, true);
  assert.equal(await oauth.connectedAccount(), null);
  await assert.rejects(oauth.getAccessToken(), /not connected/);
});

test("draft link: opens the draft in Gmail; refuses odd ids; no account -> no authuser", async () => {
  const { gmailDraftLink } = await import("../lib/gmail/links.mjs");
  assert.equal(gmailDraftLink("1a1b207d4287c04e", "alok.sharma@neocepts.com"),
    "https://mail.google.com/mail/?authuser=alok.sharma%40neocepts.com#drafts?compose=1a1b207d4287c04e");
  assert.equal(gmailDraftLink("1a1b207d4287c04e", null), "https://mail.google.com/mail/#drafts?compose=1a1b207d4287c04e");
  assert.equal(gmailDraftLink("1a1b207d4287c04e", "a b@x.com&evil=1"), "https://mail.google.com/mail/#drafts?compose=1a1b207d4287c04e");
  assert.equal(gmailDraftLink("../x\"><script>", "a@b.com"), null);
  assert.equal(gmailDraftLink(undefined, "a@b.com"), null);
});
