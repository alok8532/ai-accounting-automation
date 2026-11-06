# Gmail drafts — setup and use (POC)

Payment reminder drafts can be saved straight into a Gmail account's **Drafts** folder, in addition to
the local `.eml` files. **Nothing is ever sent.** A person opens Gmail, reviews each draft and sends it.

Gmail is the development/demo provider. The client proposal targets Zoho Mail for production; only
`lib/gmail/` is Gmail-specific, the reminder rules in `lib/reminders.mjs` stay the same.

## Why the app cannot send email

| Layer | What stops sending |
|---|---|
| Google permission | We use **`gmail.insert`** — "add emails into your Gmail mailbox". It has no send rights, so even a stolen token cannot send. |
| Permission check | After every login and token refresh the granted permissions are checked; anything extra (`gmail.send`, `gmail.compose`, `gmail.modify`, full mail access) is refused. |
| Code | `lib/gmail/client.mjs` allows exactly one Gmail call (`POST /gmail/v1/users/me/messages` with the `DRAFT` label). Every other URL — including `…/send` — is blocked before any network call. There is no send/reply/forward function in the project. |
| Claude | The MCP server has no send tool. `.claude/settings.json` denies the claude.ai Gmail connector's send / reply / forward tools. **In Claude Desktop, do not connect the claude.ai Gmail connector** for this workflow (it can send). |
| Tests | `npm test` checks all of the above (blocked endpoints, source scan for send calls, tool list). |

A fallback mode `GMAIL_SCOPE=compose` exists (real Gmail draft objects with a draft ID). That Google
permission *does* allow sending — our code still blocks it, but the token itself would be more powerful.
Use it only if `insert` stops working.

## One-time Google Cloud setup

1. **Project**: https://console.cloud.google.com → project picker (top bar) → **New project** →
   name `ai-accountant-poc` → **Create**. Make sure it is selected in the top bar for all next steps.
2. **Gmail API**: ☰ menu → **APIs & Services → Library** → search "Gmail API" → **Enable**.
3. **Consent screen**: ☰ → **Google Auth Platform** (https://console.cloud.google.com/auth/overview) →
   **Get started**:
   - App information: app name `AI Accountant POC`, support email = your email → Next
   - Audience: **External** → Next (Internal is only for company Workspace accounts)
   - Contact information: your email → Next → agree to the policy → **Create**
4. **Test user**: Google Auth Platform → **Audience** → keep Publishing status **Testing** →
   **Test users → + Add users** → the Gmail address you will connect → **Save**.
5. **Permission (scope)**: Google Auth Platform → **Data access** → **Add or remove scopes** →
   find/tick `.../auth/gmail.insert` (Gmail API, "Add emails into your Gmail mailbox") → **Update** → **Save**.
6. **Client**: Google Auth Platform → **Clients → + Create client** → type **Desktop app** →
   name `AI Accountant Desktop` → **Create**. Copy the **Client ID** and **Client secret** immediately
   (Google shows the secret only once; if lost: open the client → **+ Add secret**).
7. **Redirect URI**: nothing to configure. A Desktop client automatically allows the local
   `http://127.0.0.1:<port>` address that the login script uses.

## Connect the Gmail account (project folder, PowerShell)

1. Copy `.env.example` to `.env` (git-ignored) and fill in:
   ```
   GOOGLE_CLIENT_ID=123456789012-xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   GMAIL_SCOPE=insert
   ```
   One value per line, no quotes, no spaces around `=`. Never paste these into chat, code or Git.
2. `npm run gmail:auth` → the browser opens → choose the account → "Google hasn't verified this app" →
   **Continue** → tick the Gmail permission → **Continue**. The terminal shows `Connected: <email>`.
3. `npm run gmail:status` → shows the account, permissions, "Token refresh: OK".
4. `npm run gmail:test-draft` → one test draft (to yourself, with a small PDF) appears in Gmail → Drafts.
   Delete it after checking.

## Using it

In Claude: *"Draft payment reminders for overdue customers and save them in Gmail drafts."*
The payment-reminders skill calls `save_reminder_drafts` with `destination: "gmail"`. Without "Gmail"
the drafts are saved locally only (default). To make Gmail the default, add
`REMINDER_DRAFT_DESTINATION=gmail` to `.env` and restart Claude.

Each run returns a `runId` and, per customer: `saved` (with `gmailMessageId`), `skipped_duplicate`,
`rejected`, `error` or `not_processed` — with the reason.

**Duplicate protection** (key = customer + bill):
- A bill already put into a Gmail draft **today** is skipped — we never overwrite a draft you may have
  edited in Gmail. To redo it: delete the draft in Gmail and draft that customer manually, or wait for
  the cooldown.
- A bill drafted within `REMINDER_COOLDOWN_DAYS` (default 7) is skipped.
- The same customer twice in one run is skipped.
- If a Gmail request was interrupted (e.g. the PC shut down mid-call), that bill is skipped with
  "check Gmail Drafts" until the cooldown ends — so an interruption can never create a hidden second draft.

## Login token

- Stored at `%APPDATA%\ai-accounting-automation\gmail-token.json` (outside the project, never in Git),
  readable only by your Windows user. Only the long-lived *refresh* token is stored; the short-lived
  access token (1 hour) is kept in memory and renewed automatically.
- **Testing-mode apps: Google expires the login after 7 days.** You then see
  "Gmail login has expired … Run npm run gmail:auth" — run it again. (Production needs a verified
  app or the Zoho integration.)
- Disconnect: `npm run gmail:revoke` (also visible/removable at https://myaccount.google.com/permissions).

## Troubleshooting

| Message | Fix |
|---|---|
| `Gmail is not configured` | `.env` missing or values empty. |
| `Google rejected the client ID/secret` | Re-copy both values; check for doubled text or spaces. |
| `access_denied` / "app is blocked" | Add the account as a Test user (step 4). Company Workspace accounts may be blocked by their admin. |
| `was not granted` | Tick the Gmail checkbox on Google's consent page; run `npm run gmail:auth` again. |
| `GMAIL_SCOPE is now …` | You changed `GMAIL_SCOPE`; run `npm run gmail:auth` again. |
| `Gmail API error 403` | Gmail API not enabled in this project (step 2). |
