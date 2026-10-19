// Server-rendered pages outside the app: the end of a Google connection, and the public About and Privacy pages that
// Google's consent screen links to. Same look as the app: light, centred card, the agent blob.

const BLOB = `<svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true"><path fill="#8b5cf6" d="M10 30c0-13 10-22 24-22 13 0 22 8 22 19 0 14-11 27-27 27C17 54 10 44 10 30z" transform="rotate(-12 32 32)"/><ellipse cx="27" cy="27" rx="3.2" ry="5" fill="#fff" transform="rotate(-12 27 27)"/><ellipse cx="38" cy="25" rx="3.2" ry="5" fill="#fff" transform="rotate(-12 38 25)"/></svg>`;

const STYLE = `
:root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, sans-serif; color: #1c1c1c; background: #f5f5f5; -webkit-font-smoothing: antialiased; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
main { width: min(560px, 100%); padding: 36px 34px 30px; border: 1px solid #e6e6e6; border-radius: 20px; background: #fff; box-shadow: 0 8px 30px rgb(0 0 0 / .06); }
main.center { text-align: center; }
main.center svg { display: block; margin: 0 auto 10px; }
.status { display: inline-grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 50%; font-size: 22px; }
.ok { background: #e6f6ec; color: #1f9d55; }
.bad { background: #fdecea; color: #d93025; }
h1 { margin: 6px 0 8px; font-size: 22px; font-weight: 600; }
h2 { margin: 22px 0 6px; font-size: 15px; font-weight: 600; }
p, li { margin: 0 0 10px; color: #4b4b4b; line-height: 1.55; font-size: 14px; }
ul { padding-left: 20px; }
.muted { color: #8a8a8a; font-size: 13px; }
.account { display: inline-block; margin: 4px 0 16px; padding: 6px 14px; border-radius: 999px; background: #f3effc; color: #7442d1; font-weight: 500; }
.button { display: inline-block; margin-top: 8px; padding: 10px 20px; border-radius: 999px; background: #1c1c1c; color: #fff; text-decoration: none; font-weight: 500; font-size: 14px; }
.button:hover { background: #333; }
footer { margin-top: 24px; font-size: 12px; color: #8a8a8a; }
footer a { color: #8a8a8a; }
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function shell(title: string, body: string, centered: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Quokka Bot</title><style>${STYLE}</style></head><body><main class="${centered ? "center" : ""}">${body}</main></body></html>`;
}

// The browser lands here after Google's consent page.
export function connectedPage(ok: boolean, account: string | null, message: string, appOrigin: string): string {
  const body = ok
    ? `${BLOB}<div class="status ok">✓</div><h1>Gmail connected</h1><div class="account">${escapeHtml(account ?? "")}</div><p>Your agent can now read, search and draft email in this account. Drafts stay in Drafts until you send them.</p><p class="muted">You can close this tab. Quokka Bot carries on by itself.</p><a class="button" href="${escapeHtml(appOrigin)}/">Open Quokka Bot</a>`
    : `${BLOB}<div class="status bad">!</div><h1>Gmail not connected</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(appOrigin)}/">Back to Quokka Bot</a>`;
  return shell(ok ? "Gmail connected" : "Gmail not connected", body, true);
}

export function aboutPage(appOrigin: string, contact: string | null): string {
  return shell("About", `${BLOB}<h1>Quokka Bot</h1>
<p>Quokka Bot gives your AI agent its own computer on your own server: a browser, a workspace and a mailbox connection. You give it tasks in a chat; it works on its computer and asks you when it needs something.</p>
<p>This server belongs to its owner. Only the owner can sign in, with a passkey.</p>
<a class="button" href="${escapeHtml(appOrigin)}/">Sign in</a>
<footer><a href="${escapeHtml(appOrigin)}/privacy">Privacy</a>${contact ? ` · <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : ""}</footer>`, true);
}

export function privacyPage(appOrigin: string, contact: string | null): string {
  return shell("Privacy", `<h1>Privacy</h1>
<p class="muted">Quokka Bot on ${escapeHtml(new URL(appOrigin).host)}</p>
<p>Quokka Bot runs on its owner's own server for the owner alone. Nothing here is shared with Quokka Bot's makers or sold to anyone.</p>
<h2>Google account data</h2>
<p>When the owner connects Gmail, Quokka Bot receives access to that Gmail account through Google's own consent page. It uses it only to do what the owner asks the agent to do:</p>
<ul><li>search and read messages the task needs,</li><li>create drafts, which stay in Drafts until the owner sends them.</li></ul>
<p>The access token is stored encrypted on this server and is never shown to the AI model. The owner can disconnect at any time in Quokka Bot (Connected apps), which deletes it here and revokes it at Google.</p>
<p>Quokka Bot's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Gmail data is not used to train AI models and is not transferred to anyone except as needed to perform the owner's own tasks.</p>
<h2>Other data</h2>
<p>Tasks, files, saved logins and the activity log stay on this server. Saved passwords are encrypted and are typed into sites by Quokka Bot without the AI model seeing them.</p>
${contact ? `<h2>Contact</h2><p><a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></p>` : ""}
<footer><a href="${escapeHtml(appOrigin)}/about">About</a></footer>`, false);
}
