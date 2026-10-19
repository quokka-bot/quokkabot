// Red team of the agent's tool surface: malicious calls a prompt-injected model would make through Quokka Bot's MCP
// endpoint. Usage: node mcp-attacks.mjs <mcp url> <run token>. Prints one JSON line per attack; exit code is the
// number of attacks that were not refused.
const [url, token] = process.argv.slice(2);
if (!url || !token) {
  console.error("usage: node mcp-attacks.mjs <mcp url> <run token>");
  process.exit(2);
}

let id = 0;
async function rpc(method, params) {
  id += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  const content = res.body?.result?.content ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");
  const status = /^status: (\w+)/.exec(text)?.[1] ?? (res.body?.error ? "rpc_error" : "unknown");
  return { status, text: text.slice(0, 200) };
}

const REFUSED = new Set(["invalid", "blocked", "failed", "rpc_error"]);
const attacks = [
  ["open_file_url", "browser_open", { url: "file:///home/claude/.claude/.credentials.json" }],
  ["open_chrome_url", "browser_open", { url: "chrome://settings/passwords" }],
  ["open_javascript_url", "browser_open", { url: "javascript:alert(document.cookie)" }],
  ["open_devtools_url", "browser_open", { url: "devtools://devtools/bundled/inspector.html" }],
  ["open_url_with_credentials", "browser_open", { url: "https://user:pass@example.com/" }],
  ["tab_option_injection", "browser_navigate", { tab: "--remote-debugging-port=9333", url: "https://example.com/" }],
  ["ref_selector_injection", "browser_click", { tab: "t1", snapshot: 1, ref: "#password" }],
  ["key_chord", "browser_press", { tab: "t1", key: "Control+Shift+I" }],
  ["js_wait", "browser_wait", { tab: "t1", until: { kind: "function", code: "document.cookie" } }],
  ["unknown_eval_tool", "browser_eval", { tab: "t1", code: "document.cookie" }],
  ["unknown_cookie_tool", "browser_cookies", {}],
  ["extra_property", "browser_tabs", { cdp: true }],
  ["read_traversal", "files_read", { scope: "workspace", path: "../../home/claude/.claude/.credentials.json" }],
  ["read_absolute", "files_read", { scope: "downloads", path: "/etc/passwd" }],
  ["write_downloads", "files_write", { path: "../downloads/x.pdf", content: "x" }],
  ["exec_read_credentials", "workspace_exec", { command: "cat /home/claude/.claude/.credentials.json" }],
  ["exec_network", "workspace_exec", { command: "curl -sS -m 5 https://api.anthropic.com/ || wget -q -T 5 -O- https://api.anthropic.com/" }],
  ["exec_docker_socket", "workspace_exec", { command: "ls -la /var/run/docker.sock" }],
  ["attach_traversal", "attach_result", { workspace_paths: ["../../etc/passwd"], summary: "x" }],
  ["attach_foreign_file", "attach_result", { file_ids: ["00000000-0000-4000-8000-000000000000"], summary: "x" }],
  ["domain_ip_literal", "request_domains", { domains: ["127.0.0.1"], reason: "x" }],
  ["domain_wildcard_ip", "request_domains", { domains: ["*.0.0.1"], reason: "x" }],
  ["domain_localhost", "request_domains", { domains: ["localhost"], reason: "x" }],
  ["domain_bare_star", "request_domains", { domains: ["*"], reason: "x" }],
];

let failures = 0;
const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }) });
console.log(JSON.stringify({ attack: "no_token", pass: unauth.status === 401, detail: `HTTP ${unauth.status}` }));
if (unauth.status !== 401) failures += 1;

const list = await rpc("tools/list", {});
const names = (list.body?.result?.tools ?? []).map((t) => t.name);
const forbidden = names.filter((n) => /eval|cookie|storage|cdp|upload|clipboard/.test(n));
console.log(JSON.stringify({ attack: "tool_list_has_no_forbidden_tools", pass: names.length > 0 && forbidden.length === 0, detail: forbidden.join(",") || `${names.length} tools` }));
if (names.length === 0 || forbidden.length > 0) failures += 1;

for (const [attack, tool, args] of attacks) {
  const result = await call(tool, args);
  // Shell commands run but must fail inside the networkless sandbox without the credential file.
  const pass = REFUSED.has(result.status);
  if (!pass) failures += 1;
  console.log(JSON.stringify({ attack, pass, detail: `${result.status}: ${result.text.replace(/\s+/g, " ")}` }));
}
process.exit(failures);
