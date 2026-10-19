// Drives a real Quokka Bot install through its MCP endpoint the way the CLI does, without a model: opens the fixture
// site, checks password masking, downloads all five PDF link types, checks their hashes against the fixtures, and runs
// the hostile-page probe. Usage: node server-e2e.mjs <mcp url> <run token> <fixture base url> <fixtures dir>
// Exit code is the number of failed checks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [url, token, base, fixturesDir] = process.argv.slice(2);
if (!url || !token || !base || !fixturesDir) {
  console.error("usage: node server-e2e.mjs <mcp url> <run token> <fixture base url> <fixtures dir>");
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
  return { status: /^status: (\w+)/.exec(text)?.[1] ?? "error", text, raw: body };
}

let failures = 0;
function check(name, pass, detail = "") {
  if (!pass) failures += 1;
  console.log(JSON.stringify({ check: name, pass, detail: String(detail).replace(/\s+/g, " ").slice(0, 300) }));
}
const field = (text, key) => new RegExp(`^${key}: (.+)$`, "m").exec(text)?.[1]?.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Open the fixture page.
const opened = await call("browser_open", { url: `${base}/downloads` });
check("open_fixture_page", opened.status === "ok", opened.text);
const tab = field(opened.text, "tab") ?? "t1";
await call("browser_wait", { tab, until: { kind: "text", text: "Invoices" }, timeout_s: 20 });

// 2. Snapshot: refs present, secrets hidden.
const snap = await call("browser_snapshot", { tab });
check("snapshot_ok", snap.status === "ok", snap.text.slice(0, 200));
check("password_value_hidden", !snap.text.includes("fixture-Secret-77") && !/•{3,}/.test(snap.text), "");
check("otp_value_hidden", !snap.text.includes("123456"), "");
const generation = Number(field(snap.text, "snapshot"));

// 3. Typing into the password field is refused.
const pwRef = /textbox "Password[^"]*" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
if (pwRef) {
  const typed = await call("browser_type", { tab, snapshot: generation, ref: pwRef, text: "x" });
  check("password_typing_refused", typed.status === "blocked", typed.text);
} else {
  check("password_field_found", false, "no password textbox ref in snapshot");
}

// 4. Downloads: each link type.
const expected = {
  "Invoice 1001": "plain.pdf",
  "Invoice 1002": "attach.pdf",
  "Invoice 1003": "inline.pdf",
  "Invoice 1004": "newtab.pdf",
  "Invoice 1005": "dlattr.pdf",
};
let current = generation;
for (const [label, fixture] of Object.entries(expected)) {
  // A fresh snapshot each time: a download can change the page or open a tab.
  const s = await call("browser_snapshot", { tab });
  current = Number(field(s.text, "snapshot"));
  const ref = new RegExp(`link "${label}[^"]*" \\[ref=(e\\d+)\\]`).exec(s.text)?.[1];
  if (!ref) {
    check(`download_${fixture}`, false, "link not in snapshot");
    continue;
  }
  const started = await call("browser_download", { tab, snapshot: current, ref });
  const downloadId = /([0-9a-f-]{36})/.exec(started.text)?.[1];
  if (started.status !== "ok" || !downloadId) {
    check(`download_${fixture}`, false, started.text);
    continue;
  }
  let status;
  for (let i = 0; i < 40; i += 1) {
    status = await call("download_status", { download_id: downloadId });
    if (status.text.includes("file_id:")) break;
    await sleep(500);
  }
  const sha = field(status?.text ?? "", "sha256");
  const want = createHash("sha256").update(readFileSync(join(fixturesDir, fixture))).digest("hex");
  check(`download_${fixture}`, sha === want, `got ${sha ?? "none"} want ${want}; ${status?.text.slice(0, 120)}`);
}

// 5. The agent can read a download from its shell; the shell has no network.
const listed = await call("files_list", { scope: "downloads" });
check("downloads_listed", listed.status === "ok" && listed.text.includes(".pdf"), listed.text.slice(0, 200));
const pdfName = /file +(\S+\.pdf)/.exec(listed.text)?.[1];
if (pdfName) {
  const read = await call("files_read", { scope: "downloads", path: pdfName });
  check("pdf_text_readable", read.status === "ok" && /Invoice 100\d/.test(read.text), read.text.slice(0, 160));
}
const net = await call("workspace_exec", { command: "timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo CONNECTED || echo REFUSED" });
check("shell_has_no_network", net.text.includes("REFUSED") && !net.text.includes("CONNECTED"), net.text);

// 6. Hostile page probe. A page cannot tell a proxy refusal from a real answer (both are opaque to it), so the verdict
// comes from the egress proxy: every target the page tried must appear in the refused hosts Quokka Bot reports.
const blockedSeen = new Set();
const collect = (text) => {
  const line = /^Blocked hosts \(not allowed for this agent\): (.+?)\. Ask/m.exec(text)?.[1];
  for (const host of line?.split(", ") ?? []) blockedSeen.add(host.trim());
};
const probe = await call("browser_navigate", { tab, url: `${base}/` });
check("open_probe", probe.status === "ok", probe.text);
collect(probe.text);
const waited = await call("browser_wait", { tab, until: { kind: "text", text: "done" }, timeout_s: 30 });
collect(waited.text);
const probeSnap = await call("browser_snapshot", { tab });
collect(probeSnap.text);
const probeLines = probeSnap.text.split(/\\n|\n/).filter((l) => /^[a-z_]+: (reached|refused)/.test(l.replace(/^.*StaticText "/, "")));
check("probe_ran", probeLines.length >= 10, `${probeLines.length} probe lines`);
const mustBeRefused = ["127.0.0.1", "localhost", "10.232.1.3", "10.232.1.2", "169.254.169.254", "172.17.0.1", "192.168.1.1", "[::1]", "api.anthropic.com"];
const missing = mustBeRefused.filter((host) => !blockedSeen.has(host));
check("probe_targets_refused_by_egress", missing.length === 0, missing.length ? `not seen as refused: ${missing.join(", ")}` : [...blockedSeen].join(", "));

// 7. A blocked site is reported with its host.
const blocked = await call("browser_navigate", { tab, url: "https://example.org/" });
check("unlisted_site_blocked", blocked.text.includes("example.org"), blocked.text.slice(0, 200));

process.exit(failures);
