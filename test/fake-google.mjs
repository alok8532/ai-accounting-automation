// Fake Google OAuth + Gmail API for tests. Records every request; behaviour is set via `state`.
import { createServer } from "node:http";

export async function startFakeGoogle() {
  const state = {
    requests: [],
    grantedScope: "https://www.googleapis.com/auth/gmail.compose openid https://www.googleapis.com/auth/userinfo.email",
    refreshError: null, // e.g. "invalid_grant"
    gmailStatus: 200, // force an error status for the next Gmail call(s)
    rejectTokens: new Set(), // access tokens the Gmail API answers with 401
    issued: 0,
    drafts: [],
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body });
    const json = (status, obj) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));

    if (url.pathname === "/token") {
      const p = new URLSearchParams(body);
      if (p.get("client_secret") !== "test-secret") return json(401, { error: "invalid_client" });
      if (p.get("grant_type") === "refresh_token" && state.refreshError) return json(400, { error: state.refreshError });
      const token = `access-${++state.issued}`;
      const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.y`;
      return json(200, { access_token: token, expires_in: 3599, scope: state.grantedScope, token_type: "Bearer",
        ...(p.get("grant_type") === "authorization_code" && { refresh_token: "refresh-1", id_token: idToken }) });
    }
    if (url.pathname === "/revoke") return json(200, {});
    if (url.pathname.startsWith("/gmail/")) {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (state.rejectTokens.has(token)) return json(401, { error: { message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
      if (state.gmailStatus !== 200) return json(state.gmailStatus, { error: { message: "Backend Error", errors: [{ reason: "backendError" }] } });
      const raw = Buffer.from(JSON.parse(body).message?.raw ?? JSON.parse(body).raw, "base64url").toString("utf8");
      const id = `d${state.drafts.length + 1}`;
      state.drafts.push({ id, raw, path: url.pathname, labelIds: JSON.parse(body).labelIds });
      return url.pathname.endsWith("/drafts")
        ? json(200, { id, message: { id: `m-${id}`, threadId: `t-${id}` } })
        : json(200, { id: `m-${id}`, threadId: `t-${id}`, labelIds: ["DRAFT"] });
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}
