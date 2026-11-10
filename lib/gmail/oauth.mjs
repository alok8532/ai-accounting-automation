// Gmail OAuth 2.0 for ONE individual Gmail account (Desktop-app client, loopback redirect + PKCE).
//
// Safety:
//  - We request exactly one Gmail scope (gmail.insert or gmail.compose — GMAIL_SCOPE) plus "openid email"
//    (only to show WHICH account is connected). Google's granted scopes are checked after every login and
//    refresh; anything else (gmail.send, gmail.modify, full mail.google.com access…) is refused.
//  - Client ID/secret come from the environment (.env), never from code.
//  - The refresh token is stored OUTSIDE the project folder (default %APPDATA%\ai-accounting-automation),
//    locked to the current Windows user. The access token is kept in memory only. Tokens are never logged.

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDotEnv } from "../env.mjs";

const run = promisify(execFile);

export const GMAIL_SCOPES = Object.freeze({
  insert: "https://www.googleapis.com/auth/gmail.insert", // add messages to the mailbox — CANNOT send
  compose: "https://www.googleapis.com/auth/gmail.compose", // drafts (Google also allows sending with it — blocked in our code)
});
const IDENTITY_SCOPES = ["openid", "email"];
const IDENTITY_GRANTED = new Set(["openid", "email", "https://www.googleapis.com/auth/userinfo.email"]);

export class GmailAuthError extends Error {
  constructor(msg) { super(msg); this.name = "GmailAuthError"; this.rule = true; }
}

// Read lazily so tests (and .env) can set the environment before the first call.
export function gmailConfig() {
  loadDotEnv();
  const env = process.env;
  const mode = (env.GMAIL_SCOPE || "insert").trim().toLowerCase();
  if (!GMAIL_SCOPES[mode]) throw new GmailAuthError(`GMAIL_SCOPE must be "insert" or "compose" (got "${env.GMAIL_SCOPE}")`);
  const appData = env.APPDATA || join(homedir(), ".config");
  return {
    clientId: env.GOOGLE_CLIENT_ID?.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim(),
    mode,
    gmailScope: GMAIL_SCOPES[mode],
    tokenFile: env.GMAIL_TOKEN_FILE || join(appData, "ai-accounting-automation", "gmail-token.json"),
    authUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    revokeUrl: env.GOOGLE_REVOKE_URL || "https://oauth2.googleapis.com/revoke",
  };
}

function requireClient(cfg) {
  if (!cfg.clientId || !cfg.clientSecret)
    throw new GmailAuthError("Gmail is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (see docs/GMAIL_SETUP.md).");
}

// Every granted scope must be one we asked for. Throws otherwise — never silently run with more power.
export function checkGrantedScopes(scopeString, cfg = gmailConfig()) {
  const granted = String(scopeString ?? "").split(/\s+/).filter(Boolean);
  const extra = granted.filter((s) => s !== cfg.gmailScope && !IDENTITY_GRANTED.has(s));
  if (extra.length)
    throw new GmailAuthError(`Google granted more access than allowed (${extra.join(", ")}). Refusing to use it. ` +
      "Run npm run gmail:revoke, then npm run gmail:auth.");
  if (!granted.includes(cfg.gmailScope))
    throw new GmailAuthError(`The Gmail permission ${cfg.gmailScope} was not granted (tick it on Google's consent page). ` +
      "Run npm run gmail:auth again.");
  return granted;
}

// ---------- token file ----------

// Windows: remove inherited permissions so only the current user can read the folder/file.
async function lockDown(path, isDir) {
  if (process.platform !== "win32") return;
  const user = userInfo().username;
  try {
    await run("icacls", [path, "/inheritance:r", "/grant:r", `${user}:${isDir ? "(OI)(CI)F" : "F"}`], { windowsHide: true });
  } catch (e) {
    console.error(`Warning: could not restrict permissions on ${path} (${e.message.split("\n")[0]})`);
  }
}

export async function readToken(cfg = gmailConfig()) {
  try {
    return JSON.parse(await readFile(cfg.tokenFile, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new GmailAuthError(`Gmail token file is damaged (${cfg.tokenFile}). Run npm run gmail:auth.`);
  }
}

async function saveToken(data, cfg) {
  const dir = dirname(cfg.tokenFile);
  await mkdir(dir, { recursive: true });
  await lockDown(dir, true);
  const tmp = `${cfg.tokenFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, cfg.tokenFile);
  await lockDown(cfg.tokenFile, false);
}

// ---------- token endpoint ----------

async function tokenRequest(cfg, params) {
  let res;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`Cannot reach Google sign-in (${e.cause?.code ?? e.message}). Check the internet connection.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === "invalid_grant")
      throw new GmailAuthError("Gmail login has expired or was revoked (Testing-mode apps expire every 7 days). Run npm run gmail:auth.");
    if (body.error === "invalid_client")
      throw new GmailAuthError("Google rejected the client ID/secret. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.");
    throw new Error(`Google token request failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
  }
  return body;
}

// The id_token comes straight from Google's token endpoint over HTTPS; we only read the email from it.
const emailFromIdToken = (idToken) => {
  try { return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")).email ?? null; } catch { return null; }
};

// ---------- access token (in memory) ----------

let cache = null; // { accessToken, expiresAt, tokenFile }

export function invalidateAccessToken() { cache = null; }

// Returns a valid access token, refreshing it with the stored refresh token when needed.
export async function getAccessToken({ now = Date.now } = {}) {
  const cfg = gmailConfig();
  if (cache && cache.tokenFile === cfg.tokenFile && cache.expiresAt - 60000 > now()) return cache.accessToken;
  requireClient(cfg);
  const saved = await readToken(cfg);
  if (!saved?.refresh_token) throw new GmailAuthError("Gmail is not connected. Run npm run gmail:auth.");
  if (saved.client_id !== cfg.clientId) throw new GmailAuthError("The Gmail login belongs to a different OAuth client. Run npm run gmail:auth.");
  if (saved.gmail_scope !== cfg.gmailScope)
    throw new GmailAuthError(`The Gmail login was made for ${saved.gmail_scope}, but GMAIL_SCOPE is now ${cfg.mode}. Run npm run gmail:auth.`);

  const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: saved.refresh_token });
  checkGrantedScopes(t.scope ?? saved.scope, cfg);
  if (t.refresh_token && t.refresh_token !== saved.refresh_token) await saveToken({ ...saved, refresh_token: t.refresh_token }, cfg);
  cache = { accessToken: t.access_token, expiresAt: now() + (Number(t.expires_in) || 3600) * 1000, tokenFile: cfg.tokenFile };
  return cache.accessToken;
}

export async function connectedAccount() {
  const saved = await readToken();
  return saved && { account: saved.account, scope: saved.scope, connectedAt: saved.created_at };
}

// ---------- interactive login (npm run gmail:auth) ----------

function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd, args, { windowsHide: true }, () => {}); // if it fails, the URL is printed anyway
}

export async function login({ open = openBrowser, log = console.log, timeoutMs = 5 * 60000 } = {}) {
  const cfg = gmailConfig();
  requireClient(cfg);
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/") { res.writeHead(404).end(); return; }
    const err = u.searchParams.get("error");
    const ok = !err && u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<p style="font-family:Arial">${ok ? "Gmail connected. You can close this tab and go back to the terminal."
        : "Gmail connection failed. Go back to the terminal for details."}</p>`);
    if (err) finish.reject(new GmailAuthError(err === "access_denied" ? "You cancelled the Google consent screen." : `Google returned: ${err}`));
    else if (u.searchParams.get("state") !== state) finish.reject(new GmailAuthError("Login response did not match this request (state). Try again."));
    else finish.resolve(u.searchParams.get("code"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish.reject(new GmailAuthError("Timed out waiting for the Google login (5 minutes).")), timeoutMs);

  try {
    const url = `${cfg.authUrl}?${new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code",
      scope: [cfg.gmailScope, ...IDENTITY_SCOPES].join(" "),
      access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
    })}`;
    log(`Opening your browser for the Google login. If it does not open, copy this link into the browser:\n\n${url}\n`);
    open(url);
    const code = await done;
    const t = await tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const granted = checkGrantedScopes(t.scope, cfg);
    if (!t.refresh_token) throw new GmailAuthError("Google did not return a refresh token. Run npm run gmail:revoke, then npm run gmail:auth.");
    const account = emailFromIdToken(t.id_token ?? "");
    await saveToken({
      refresh_token: t.refresh_token, scope: granted.join(" "), gmail_scope: cfg.gmailScope,
      client_id: cfg.clientId, account, created_at: new Date().toISOString(),
    }, cfg);
    cache = { accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000, tokenFile: cfg.tokenFile };
    return { account, scope: granted, tokenFile: cfg.tokenFile };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// Revoke at Google AND delete the local token file.
export async function revoke() {
  const cfg = gmailConfig();
  const saved = await readToken(cfg);
  invalidateAccessToken();
  if (!saved) return { revoked: false, message: "No Gmail login stored." };
  let atGoogle = true;
  try {
    const res = await fetch(cfg.revokeUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: saved.refresh_token }), signal: AbortSignal.timeout(20000),
    });
    atGoogle = res.ok || res.status === 400; // 400 = already invalid
  } catch { atGoogle = false; }
  await rm(cfg.tokenFile, { force: true });
  return { revoked: true, atGoogle, account: saved.account };
}
