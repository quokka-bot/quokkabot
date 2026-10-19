// Drives the login vault on a real install through the MCP endpoint, the way the CLI does: the agent lists its saved
// logins, has Quokka Bot type a username, password and 2FA code into the fixture sign-in page in real Chrome, and the
// page's digests prove the right values arrived while no tool result carried them. A login for another site must be
// refused. Usage: node vault-e2e.mjs <mcp url> <run token> <fixture base url>
// Env: QB_LOGIN_ID (login for the fixture host), QB_OTHER_LOGIN_ID (login for another site), QB_USERNAME, QB_PASSWORD,
// QB_TOTP_SECRET (base32). Exit code is the number of failed checks.
import { createHash, createHmac } from "node:crypto";

const [url, token, base] = process.argv.slice(2);
const { QB_LOGIN_ID: loginId, QB_OTHER_LOGIN_ID: otherId, QB_USERNAME: username, QB_PASSWORD: password, QB_TOTP_SECRET: totpSecret } = process.env;
if (!url || !token || !base || !loginId || !otherId || !username || !password || !totpSecret) {
  console.error("usage: QB_LOGIN_ID=... QB_OTHER_LOGIN_ID=... QB_USERNAME=... QB_PASSWORD=... QB_TOTP_SECRET=... node vault-e2e.mjs <mcp url> <run token> <fixture base url>");
  process.exit(2);
}

let id = 0;
async function call(name, args) {
  id += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = (body?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { status: /^status: (\w+)/.exec(text)?.[1] ?? "error", text };
}

let failures = 0;
function check(name, pass, detail = "") {
  if (!pass) failures += 1;
  console.log(JSON.stringify({ check: name, pass, detail: String(detail).replace(/\s+/g, " ").slice(0, 300) }));
}
const field = (text, key) => new RegExp(`^${key}: (.+)$`, "m").exec(text)?.[1]?.trim();
const sha = (value) => createHash("sha256").update(value).digest("hex");

function base32(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const char of input.toUpperCase().replace(/[\s=]/g, "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, at) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", base32(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Every tool result in this test must be free of the secret values.
const results = [];
async function tool(name, args) {
  const result = await call(name, args);
  results.push(result.text);
  return result;
}

const list = await tool("logins_list", {});
check("logins_listed", list.text.includes(loginId) && list.text.includes(otherId) && list.text.includes("2FA code available"), list.text);

const opened = await tool("browser_open", { url: `${base}/login` });
const tab = field(opened.text, "tab") ?? "t1";
await tool("browser_wait", { tab, until: { kind: "text", text: "Not signed in" }, timeout_s: 20 });
let snap = await tool("browser_snapshot", { tab, interactive_only: true });
let generation = Number(field(snap.text, "snapshot"));
const ref = (label) => new RegExp(`textbox "${label}[^"]*" \\[ref=(e\\d+)\\]`).exec(snap.text)?.[1];
check("fields_found", Boolean(ref("Email") && ref("Password") && ref("Code")), snap.text.slice(0, 300));

const wrongSite = await tool("browser_fill_login", { tab, snapshot: generation, ref: ref("Password"), login_id: otherId, field: "password" });
check("other_site_login_refused", wrongSite.status === "blocked" && /wrong site/.test(wrongSite.text), wrongSite.text);

const asked = await tool("request_login", { site: new URL(base).hostname, name: "Fixture", reason: "Sign in to the fixture site" });
check("saved_login_never_requested", asked.status === "invalid" && asked.text.includes(loginId), asked.text);

const user = await tool("browser_fill_login", { tab, snapshot: generation, ref: ref("Email"), login_id: loginId, field: "username" });
check("username_typed", user.status === "ok", user.text);
const pass = await tool("browser_fill_login", { tab, snapshot: generation, ref: ref("Password"), login_id: loginId, field: "password" });
check("password_typed", pass.status === "ok", pass.text);
if (pass.status !== "ok") { snap = await tool("browser_snapshot", { tab, interactive_only: true }); generation = Number(field(snap.text, "snapshot")); }
// The page now holds a typed secret: images of it are refused, snapshots mask the fields.
const shot = await tool("browser_screenshot", { tab });
check("screenshot_refused_after_fill", shot.status === "blocked" && /browser_snapshot/.test(shot.text), shot.text);
const before = Date.now();
const code = await tool("browser_fill_code", { tab, snapshot: generation, ref: ref("Code"), login_id: loginId, submit: true });
const after = Date.now();
check("code_typed_and_submitted", code.status === "ok", code.text);

await tool("browser_wait", { tab, until: { kind: "text", text: "Signed in." }, timeout_s: 10 });
const page = await tool("browser_snapshot", { tab });
const digests = /user ([0-9a-f]{64}) pass ([0-9a-f]{64}) code ([0-9a-f]{64})/.exec(page.text);
check("page_signed_in", Boolean(digests), page.text.slice(0, 300));
if (digests) {
  check("username_arrived", digests[1] === sha(username), "");
  check("password_arrived", digests[2] === sha(password), "");
  const codes = new Set([before - 30_000, before, after, after + 30_000].map((at) => sha(totp(totpSecret, at))));
  check("totp_code_arrived", codes.has(digests[3]), "");
}

// Another page loads: screenshots work again.
await tool("browser_navigate", { tab, url: `${base}/downloads` });
await tool("browser_wait", { tab, until: { kind: "text", text: "Invoices" }, timeout_s: 20 });
const later = await tool("browser_screenshot", { tab });
check("screenshot_allowed_on_next_page", later.status === "ok", later.text.slice(0, 200));

const codesNear = [before - 30_000, before, after, after + 30_000].map((at) => totp(totpSecret, at));
const leaked = results.filter((text) => text.includes(password) || codesNear.some((c) => new RegExp(`\\b${c}\\b`).test(text)));
check("no_value_in_tool_results", leaked.length === 0, leaked.join(" | ").slice(0, 200).replaceAll(password, "[password]"));

console.log(JSON.stringify({ failures }));
process.exit(failures);
