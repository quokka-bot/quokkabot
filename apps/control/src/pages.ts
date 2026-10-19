// Server-rendered pages outside the app: the end of a Google connection, and the public About and Privacy pages that
// Google's consent screen links to. Same look as the app: light, centred card, the Quokka Bot mark.

const LOGO = `<svg width="56" height="56" viewBox="222 192 580 580" aria-hidden="true"><rect x="279.375" y="290.5" width="470" height="66" rx="33" transform="rotate(-7 514.375 323.5)" fill="#0f1417"/><rect x="232" y="402" width="560" height="300" rx="118" fill="#0f1417"/><ellipse cx="452" cy="552" rx="42" ry="75" fill="#fff"/><ellipse cx="662" cy="552" rx="42" ry="75" fill="#fff"/></svg>`;

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
    ? `${LOGO}<div class="status ok">✓</div><h1>Gmail connected</h1><div class="account">${escapeHtml(account ?? "")}</div><p>Your agent can now read, search and draft email in this account. Drafts stay in Drafts until you send them.</p><p class="muted">You can close this tab. Quokka Bot carries on by itself.</p><a class="button" href="${escapeHtml(appOrigin)}/">Open Quokka Bot</a>`
    : `${LOGO}<div class="status bad">!</div><h1>Gmail not connected</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(appOrigin)}/">Back to Quokka Bot</a>`;
  return shell(ok ? "Gmail connected" : "Gmail not connected", body, true);
}

export function aboutPage(appOrigin: string, contact: string | null): string {
  return shell("About", `${LOGO}<h1>Quokka Bot</h1>
<p>Quokka Bot gives your AI agent its own computer on your own server: a browser, a workspace and a mailbox connection. You give it tasks in a chat; it works on its computer and asks you when it needs something.</p>
<p>This server belongs to its owner. Only the owner can sign in, with a passkey.</p>
<a class="button" href="${escapeHtml(appOrigin)}/">Sign in</a>
<footer><a href="${escapeHtml(appOrigin)}/privacy">Privacy</a>${contact ? ` · <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : ""}</footer>`, true);
}

export function privacyPage(appOrigin: string, contact: string | null): string {
  return shell("Privacy", `<h1>Privacy</h1>
<p class="muted">Quokka Bot on ${escapeHtml(new URL(appOrigin).host)}</p>
<p>Quokka Bot runs on its owner's own server for the owner alone. The software sends nothing to Quokka Bot's makers, and nothing here is sold.</p>
<h2>What the AI model sees</h2>
<p>The agent runs Claude Code signed in with the owner's own Claude plan. Anthropic receives what the agent works with: the owner's messages and images, pages it opens, files it reads, command output and email it reads. Anthropic's terms for that plan apply. Saved passwords, 2FA codes and access tokens never reach the model.</p>
<h2>Google account data</h2>
<p>When the owner connects Gmail, Quokka Bot receives access to that Gmail account through Google's own consent page. It uses it only to do what the owner asks the agent to do:</p>
<ul><li>search and read messages the task needs,</li><li>create drafts, which stay in Drafts until the owner sends them.</li></ul>
<p>The refresh token is stored encrypted on this server and is never shown to the AI model. The owner can disconnect at any time in Quokka Bot (Connected apps), which deletes it here and revokes it at Google.</p>
<p>Quokka Bot's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Gmail data goes to the AI model working on the owner's own task. The first 300 characters of each Gmail result the agent gets (senders, recipients, dates, subjects and the start of the text), and what the agent writes about it, are saved with the task on this server and in the encrypted backups when the owner turns them on. Gmail data is never used for advertising and is never sold.</p>
<h2>Other data</h2>
<p>Tasks, files, browser data, saved logins and the activity log are stored on this server. Saved passwords and 2FA secrets are encrypted. Quokka Bot types them into sites; the AI model never sees them. If the owner turns on backups, encrypted copies go to a storage bucket the owner chooses.</p>
<p>The full list of what Quokka Bot stores and sends, and to whom: <a href="https://quokkabot.com/privacy">quokkabot.com/privacy</a>.</p>
${contact ? `<h2>Contact</h2><p><a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></p>` : ""}
<footer><a href="${escapeHtml(appOrigin)}/about">About</a></footer>`, false);
}
