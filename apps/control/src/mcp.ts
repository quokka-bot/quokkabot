import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import {
  BROWSER_TOOL_NAMES,
  type BrowserCommandResult,
  type BrowserOp,
  type DomainRequestId,
  LIMITS,
  MCP_TOOLS,
  type McpToolInput,
  type McpToolName,
  MUTATING_BROWSER_OPS,
  type ResultFile,
  hostMatchesPattern,
  siteLabel,
} from "@quokkabot/shared";
import { sha256Hex, sitePattern, sitePatterns } from "@quokkabot/shared/node";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { z } from "zod";
import type { AuditLog } from "./audit.js";
import type { SupervisorClient } from "./clients.js";
import type { AgentHandles, ComputerService } from "./computer.js";
import { type Db, many, maybeOne, one, withTx } from "./db.js";
import { type EvidenceStore, mimeFor } from "./files.js";
import type { Vault } from "./vault.js";
import type { Connectors } from "./connectors.js";
import { HttpError } from "./errors.js";

const SIGN_IN_WORDS = /\b(log ?in|logging in|sign ?in|signing in|password|credentials?|username)\b/i;
import type { TaskEvents } from "./events.js";
import type { PolicyService } from "./policy.js";
import { type TaskRow, type TaskService, ownerRequestView, siteDecisionText } from "./tasks.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolOutcome {
  status: "ok" | "blocked" | "invalid" | "failed" | "outcome_unknown";
  text: string;
  image?: { data: string; mimeType: string };
}

interface CallContext {
  runId: string;
  task: TaskRow;
  agentId: string;
}

function clip(text: string, max = LIMITS.toolResultChars): string {
  return text.length <= max ? text : `${text.slice(0, max - 60)}\n[cut at ${max} characters]`;
}

export class McpEndpoint {
  private readonly pending = new Map<string, Set<Promise<ToolOutcome>>>();
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly events: TaskEvents,
    private readonly audit: AuditLog,
    private readonly supervisor: SupervisorClient,
    private readonly computer: ComputerService,
    private readonly policy: PolicyService,
    private readonly handles: (agentId: string) => AgentHandles,
    private readonly evidence: EvidenceStore,
    private readonly vault: Vault,
    private readonly connectors: Connectors,
    private readonly log: Logger,
    private readonly mcpUrl: (agentId: string) => string | null,
    private readonly siteWaitMs = 90_000,
  ) {}

  // Plain node:http listener bound to the CLI network address only. Every request needs the run's bearer token.
  async listen(address: string, port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.log.error({ err: String(error) }, "mcp request failed");
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, () => { server.off("error", reject); resolve(); });
    });
    return server;
  }

  private async authenticate(req: http.IncomingMessage): Promise<CallContext | null> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
    if (!match?.[1]) return null;
    const run = await maybeOne<{ id: string; task_id: string; agent_id: string }>(
      this.db,
      "select id, task_id, agent_id from runs where mcp_token_hash = $1 and not token_revoked and state in ('starting','running')",
      [sha256Hex(match[1])],
    );
    if (!run) return null;
    if (!mcpLocalAddressMatches(req.socket.localAddress, this.mcpUrl(run.agent_id))) return null;
    const task = await this.tasks.get(run.task_id);
    return { runId: run.id, task, agentId: run.agent_id };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const ctx = await this.authenticate(req);
    if (!ctx) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid or revoked token" }));
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    const server = new Server({ name: "quokkabot", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Object.entries(MCP_TOOLS).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as { type: "object" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const outcome = await this.call(ctx, request.params.name, request.params.arguments ?? {});
      const content: Content[] = [{ type: "text", text: clip(`status: ${outcome.status}\n${outcome.text}`) }];
      if (outcome.image) content.push({ type: "image", data: outcome.image.data, mimeType: outcome.image.mimeType });
      return { content, isError: outcome.status === "invalid" || outcome.status === "failed" };
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no session id generator: stateless
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as never);
    await transport.handleRequest(req, res, body);
  }

  call(ctx: CallContext, name: string, args: unknown): Promise<ToolOutcome> {
    const calls = this.pending.get(ctx.agentId) ?? new Set<Promise<ToolOutcome>>();
    const promise = this.callNow(ctx, name, args);
    calls.add(promise);
    this.pending.set(ctx.agentId, calls);
    const finish = () => { calls.delete(promise); if (calls.size === 0) this.pending.delete(ctx.agentId); };
    void promise.then(finish, finish);
    return promise;
  }

  async drainAgent(agentId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          for (;;) {
            const calls = this.pending.get(agentId);
            if (!calls) return;
            await Promise.allSettled(calls);
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HttpError(409, "agent_busy", "Tools are still stopping. Retry Remove agent.")), 30_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async callNow(ctx: CallContext, name: string, args: unknown): Promise<ToolOutcome> {
    if (!(name in MCP_TOOLS)) return { status: "invalid", text: `Unknown tool ${name}.` };
    const tool = name as McpToolName;
    const parsed = MCP_TOOLS[tool].input.safeParse(args);
    if (!parsed.success) {
      return { status: "invalid", text: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ")}` };
    }
    const run = await one<{ fenced_at: Date | null; fence_reason: string | null }>(this.db, "select fenced_at, fence_reason from runs where id = $1", [ctx.runId]);
    if (run.fenced_at) {
      return { status: "blocked", text: "You are waiting for the owner. End your turn now; you continue when they answer." };
    }
    await this.audit.append(ctx.agentId, "agent", "tool.called", { runId: ctx.runId, tool, input: this.auditInput(parsed.data) });
    let outcome: ToolOutcome;
    try {
      outcome = await this.dispatch(ctx, tool, parsed.data as never);
    } catch (error) {
      outcome = { status: "failed", text: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
    }
    await this.audit.append(ctx.agentId, "agent", "tool.result", { runId: ctx.runId, tool, status: outcome.status });
    return outcome;
  }

  // Free text in tool inputs is stored as a keyed hash; identifiers, URLs and commands as they are (capped).
  private auditInput(input: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof input !== "object" || input === null) return out;
    for (const [key, value] of Object.entries(input)) {
      if (["text", "content", "new_string", "old_string", "question", "what_to_do", "reason", "summary", "body", "subject", "query", "to", "cc"].includes(key) && (typeof value === "string" || Array.isArray(value))) {
        out[key] = this.audit.textDigest(typeof value === "string" ? value : JSON.stringify(value));
      } else if (typeof value === "string") {
        out[key] = value.slice(0, 500);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private async dispatch<N extends McpToolName>(ctx: CallContext, tool: N, input: McpToolInput<N>): Promise<ToolOutcome> {
    if (BROWSER_TOOL_NAMES.has(tool) && tool !== "browser_fill_login" && tool !== "browser_fill_code") {
      return this.browserTool(ctx, tool, input as Record<string, unknown>);
    }
    switch (tool) {
      case "download_status":
        return this.downloadStatus(ctx, (input as McpToolInput<"download_status">).download_id);
      case "files_list":
        return this.filesList(ctx, input as McpToolInput<"files_list">);
      case "files_read":
        return this.filesRead(ctx, input as McpToolInput<"files_read">);
      case "files_write": {
        const i = input as McpToolInput<"files_write">;
        const r = await this.supervisor.files(ctx.agentId, { op: "write", path: i.path, content: i.content });
        if (r.op === "error") return { status: "failed", text: `${r.code}: ${r.message}` };
        await this.audit.append(ctx.agentId, "agent", "file.written", { path: i.path, bytes: r.op === "write" ? r.bytes : null });
        return { status: "ok", text: `Wrote ${i.path}.` };
      }
      case "files_edit": {
        const i = input as McpToolInput<"files_edit">;
        const r = await this.supervisor.files(ctx.agentId, {
          op: "edit",
          path: i.path,
          oldString: i.old_string,
          newString: i.new_string,
          replaceAll: i.replace_all,
        });
        if (r.op === "error") return { status: "failed", text: `${r.code}: ${r.message}` };
        return { status: "ok", text: `Edited ${i.path} (${r.op === "edit" ? r.replacements : 0} replacement(s)).` };
      }
      case "files_copy_to_workspace": {
        const i = input as McpToolInput<"files_copy_to_workspace">;
        const file = await maybeOne<{ rel_path: string }>(
          this.db,
          "select rel_path from files where id = $1 and agent_id = $2 and scope = 'downloads'",
          [i.file_id, ctx.agentId],
        );
        if (!file) return { status: "invalid", text: "No downloaded file with that id." };
        const r = await this.supervisor.files(ctx.agentId, { op: "copy_from_downloads", source: file.rel_path, dest: i.dest });
        if (r.op === "error") return { status: "failed", text: `${r.code}: ${r.message}` };
        return { status: "ok", text: `Copied to ${i.dest}${r.op === "copy_from_downloads" ? ` (sha256 ${r.sha256})` : ""}.` };
      }
      case "workspace_exec": {
        const i = input as McpToolInput<"workspace_exec">;
        const r = await this.supervisor.exec(ctx.agentId, {
          execId: randomBytes(12).toString("base64url"),
          command: i.command,
          cwd: i.cwd,
          timeoutS: i.timeout_s,
        });
        await this.audit.append(ctx.agentId, "agent", "exec.ran", {
          command: this.audit.textDigest(i.command),
          exitCode: r.exitCode,
          timedOut: r.timedOut,
        });
        const half = Math.floor(LIMITS.execOutputChars / 2);
        return {
          status: r.exitCode === 0 ? "ok" : "failed",
          text: [
            `exit code: ${r.exitCode ?? "none"}${r.timedOut ? " (timed out)" : ""}${r.truncated ? " (output cut)" : ""}`,
            r.stdout ? `stdout:\n${r.stdout.slice(-half)}` : "stdout: (empty)",
            r.stderr ? `stderr:\n${r.stderr.slice(-half)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
      case "logins_list": {
        const logins = await this.vault.list(ctx.agentId);
        if (logins.length === 0) return { status: "ok", text: "No saved logins. Ask for one with request_login when a site needs it." };
        return {
          status: "ok",
          text: logins
            .map((l) => `${l.id}  ${l.name}  user ${l.username}  sites ${l.sites.join(", ")}${l.hasTotp ? "  2FA code available" : ""}`)
            .join("\n"),
        };
      }
      case "browser_fill_login": {
        const i = input as McpToolInput<"browser_fill_login">;
        return this.fillSecret(ctx, i.tab, i.snapshot, i.ref, i.login_id, i.field, i.submit);
      }
      case "browser_fill_code": {
        const i = input as McpToolInput<"browser_fill_code">;
        return this.fillSecret(ctx, i.tab, i.snapshot, i.ref, i.login_id, "code", i.submit);
      }
      case "request_login":
        return this.requestLogin(ctx, input as McpToolInput<"request_login">);
      case "gmail_search": {
        const i = input as McpToolInput<"gmail_search">;
        return this.connected(ctx, () => this.connectors.gmailSearch(ctx.agentId, i.query, i.max_results));
      }
      case "gmail_read": {
        const i = input as McpToolInput<"gmail_read">;
        return this.connected(ctx, () => this.connectors.gmailRead(ctx.agentId, i.message_id));
      }
      case "gmail_create_draft": {
        const i = input as McpToolInput<"gmail_create_draft">;
        return this.connected(ctx, async () => `Draft saved in Gmail Drafts (draft id ${await this.connectors.gmailCreateDraft(ctx.agentId, i)}). It is not sent.`);
      }
      case "request_connection":
        return this.requestConnection(ctx, input as McpToolInput<"request_connection">);
      case "request_domains":
        return this.requestDomains(ctx, input as McpToolInput<"request_domains">);
      case "ask_owner":
        return this.askOwner(ctx, (input as McpToolInput<"ask_owner">).question);
      case "react": {
        const { emoji } = input as McpToolInput<"react">;
        await this.tasks.react(ctx.task.id, { by: "agent", emoji });
        return { status: "ok", text: emoji === null ? "Reaction removed." : "Reaction added." };
      }
      case "request_takeover": {
        const i = input as McpToolInput<"request_takeover">;
        return this.requestTakeover(ctx, i.reason, i.what_to_do);
      }
      case "attach_result":
        return this.attachResult(ctx, input as McpToolInput<"attach_result">);
      default:
        return { status: "invalid", text: `Tool ${tool} is not available.` };
    }
  }

  // --- Browser ------------------------------------------------------------------------------------------------------

  private toOp(tool: McpToolName, input: Record<string, unknown>): BrowserOp {
    const op = tool.replace(/^browser_/, "");
    const { interactive_only, timeout_s, ...rest } = input as Record<string, unknown> & { interactive_only?: boolean; timeout_s?: number };
    if (op === "snapshot") return { op: "snapshot", ...(rest as object), interactiveOnly: interactive_only ?? false } as BrowserOp;
    if (op === "wait") return { op: "wait", ...(rest as object), timeoutS: timeout_s ?? 10 } as BrowserOp;
    return { op, ...rest } as BrowserOp;
  }

  private async browserTool(ctx: CallContext, tool: McpToolName, input: Record<string, unknown>): Promise<ToolOutcome> {
    const lease = await this.computer.lease(ctx.agentId);
    if (lease.holder !== "agent") {
      return {
        status: "blocked",
        text: lease.holder === "owner" ? "The owner has control of the browser right now." : "The browser is paused. Wait for the owner or end your turn.",
      };
    }
    const op = this.toOp(tool, input);
    const commandId = randomBytes(12).toString("base64url");
    const started = Date.now();
    await this.db.query("insert into browser_commands (id, agent_id, run_id, op) values ($1, $2, $3, $4)", [commandId, ctx.agentId, ctx.runId, op.op]);
    await this.audit.append(ctx.agentId, "agent", "browser.command", { commandId, ...this.auditInput(op) });
    let result: BrowserCommandResult;
    try {
      result = await this.handles(ctx.agentId).browser.command({ commandId, runId: ctx.runId as never, generation: lease.generation, op });
    } catch (error) {
      const uncertain = MUTATING_BROWSER_OPS.has(op.op);
      result = { commandId, status: uncertain ? "outcome_unknown" : "failed", message: String(error).slice(0, 300) };
    }
    await this.db.query("update browser_commands set status = $2, finished_at = now() where id = $1", [commandId, result.status]);
    if (result.status === "outcome_unknown") {
      await this.db.query("update runs set uncertain_mutations = uncertain_mutations + 1 where id = $1", [ctx.runId]);
    }
    await this.audit.append(ctx.agentId, "agent", "browser.result", { commandId, status: result.status });
    const blocked = this.policy.blockedSince(ctx.agentId, started);
    return this.formatBrowser(op, result, blocked);
  }

  private formatBrowser(op: BrowserOp, result: BrowserCommandResult, blocked: string[]): ToolOutcome {
    const lines: string[] = [];
    if (result.message) lines.push(result.message);
    if (result.tabs) {
      for (const tab of result.tabs) lines.push(`${tab.active ? "*" : " "} ${tab.tab}  ${tab.title}  ${tab.url}`);
    }
    if (result.tab) lines.push(`tab: ${result.tab}`);
    if (result.url) lines.push(`url: ${result.url}`);
    if (result.title) lines.push(`title: ${result.title}`);
    if (result.snapshot !== undefined) lines.push(`snapshot: ${result.snapshot}${result.pages && result.pages > 1 ? ` (page ${result.page} of ${result.pages})` : ""}`);
    if (result.download) lines.push(`download started: ${result.download.downloadId} (${result.download.suggestedFilename}). Check it with download_status.`);
    if (blocked.length > 0) {
      lines.push(`Blocked hosts (not allowed for this agent): ${blocked.join(", ")}. Ask for the ones the page needs with request_domains.`);
    }
    if (result.text) lines.push("", result.text);
    const outcome: ToolOutcome = { status: result.status, text: lines.join("\n") };
    if (op.op === "screenshot" && result.pngBase64) outcome.image = { data: result.pngBase64, mimeType: "image/png" };
    return outcome;
  }

  private async downloadStatus(ctx: CallContext, downloadId: string): Promise<ToolOutcome> {
    const file = await maybeOne<{ id: string; name: string; bytes: number; sha256: string }>(
      this.db,
      "select id, name, bytes, sha256 from files where download_id = $1 and agent_id = $2",
      [downloadId, ctx.agentId],
    );
    if (file) {
      return { status: "ok", text: `completed\nfile_id: ${file.id}\nname: ${file.name}\npath: Downloads/${file.name}\nbytes: ${file.bytes}\nsha256: ${file.sha256}` };
    }
    const { downloads } = await this.handles(ctx.agentId).browser.downloads(null);
    const download = downloads.find((d) => d.downloadId === downloadId);
    if (!download) return { status: "invalid", text: "No download with that id." };
    if (download.state === "completed") return { status: "ok", text: "completed, being saved to Downloads; check again in a few seconds" };
    return { status: download.state === "in_progress" ? "ok" : "failed", text: `${download.state} (${download.receivedBytes} bytes so far)` };
  }

  // --- Logins ---------------------------------------------------------------------------------------------------------

  // Types a saved login's username, password or current 2FA code. The value goes from the vault to the browser service
  // and never into a tool result, the audit log or the model.
  private async fillSecret(
    ctx: CallContext,
    tab: string,
    snapshot: number,
    ref: string,
    loginId: string,
    kind: "username" | "password" | "code",
    submit: boolean,
  ): Promise<ToolOutcome> {
    const lease = await this.computer.lease(ctx.agentId);
    if (lease.holder !== "agent") return { status: "blocked", text: "The browser is not yours right now." };
    let secret: { value: string; sites: string[]; name: string };
    try {
      secret = await this.vault.secretFor(ctx.agentId, loginId, kind);
    } catch (error) {
      return { status: "invalid", text: error instanceof Error ? error.message : "No such login." };
    }
    const commandId = randomBytes(12).toString("base64url");
    await this.db.query("insert into browser_commands (id, agent_id, run_id, op) values ($1, $2, $3, $4)", [commandId, ctx.agentId, ctx.runId, `fill_${kind}`]);
    let result: BrowserCommandResult;
    try {
      result = await this.handles(ctx.agentId).browser.secretFill({
        commandId,
        runId: ctx.runId as never,
        generation: lease.generation,
        tab: tab as never,
        snapshot,
        ref: ref as never,
        kind,
        value: secret.value,
        allowedPatterns: secret.sites,
        submit,
      });
    } catch (error) {
      result = { commandId, status: "outcome_unknown", message: String(error).slice(0, 200).replaceAll(secret.value, "[hidden]") };
    }
    // The browser service never echoes the value; this keeps it out of the model's context if it ever did.
    if (result.message && secret.value.length > 0) result = { ...result, message: result.message.replaceAll(secret.value, "[hidden]") };
    await this.db.query("update browser_commands set status = $2, finished_at = now() where id = $1", [commandId, result.status]);
    if (result.status === "outcome_unknown") await this.db.query("update runs set uncertain_mutations = uncertain_mutations + 1 where id = $1", [ctx.runId]);
    await this.audit.append(ctx.agentId, "agent", "login.used", { loginId, kind, status: result.status });
    if (result.status === "ok") await this.vault.markUsed(loginId);
    const what = kind === "code" ? "2FA code" : kind;
    if (result.status === "ok") return { status: "ok", text: `Typed the ${what} of "${secret.name}"${submit ? " and pressed Enter" : ""}. Take a new snapshot.` };
    if (result.status === "blocked" && result.message?.startsWith("wrong site: the field is on ")) {
      return {
        status: "blocked",
        text: `${result.message}. "${secret.name}" is saved for ${secret.sites.map(siteLabel).join(", ")} with all subdomains. ` +
          `If this page is where that account really signs in, call request_login with login_id ${loginId}, the page's site and ` +
          `problem "wrong site": the owner allows the site with one click.`,
      };
    }
    return { status: result.status, text: result.message ?? `Could not type the ${what}.` };
  }

  private async requestLogin(ctx: CallContext, input: McpToolInput<"request_login">): Promise<ToolOutcome> {
    // Logins belong to sites: a request for www.roblox.com asks for roblox.com.
    let site: string;
    try {
      site = siteLabel(sitePattern(input.site));
    } catch (error) {
      return { status: "invalid", text: error instanceof Error ? error.message : "Invalid site." };
    }
    const covers = (sites: string[]) => sites.some((pattern) => hostMatchesPattern(site, pattern));
    const covering = async () => (await this.vault.list(ctx.agentId)).find((l) => covers(l.sites));
    let repair: { id: string; name: string; otherSite: boolean } | null = null;
    if (input.login_id !== undefined) {
      if (input.problem === undefined) return { status: "invalid", text: "Say what the site said about the saved login in `problem`." };
      const login = (await this.vault.list(ctx.agentId)).find((l) => l.id === input.login_id);
      if (!login) return { status: "invalid", text: `No saved login ${input.login_id}. Check logins_list.` };
      repair = { id: login.id, name: login.name, otherSite: !covers(login.sites) };
    } else {
      const existing = await covering();
      if (existing) {
        return {
          status: "invalid",
          text: `You already have a saved login for ${site}: "${existing.name}" (login_id ${existing.id}). Use browser_fill_login instead of asking. If the site rejected it, call request_login with its login_id and the site's words in problem.`,
        };
      }
    }
    const id = randomUUID();
    await this.tasks.fence(ctx.runId, "login");
    const text = repair ? `${input.reason}\nThe site said: ${input.problem ?? ""}` : input.reason;
    const row = await one<Parameters<typeof ownerRequestView>[0]>(
      this.db,
      "insert into owner_requests (id, task_id, run_id, kind, text, site, login_name, login_id) values ($1, $2, $3, 'login', $4, $5, $6, $7) returning *",
      [id, ctx.task.id, ctx.runId, text, site, repair?.name ?? input.name, repair?.id ?? null],
    );
    await this.db.query("update tasks set blocked_reason = 'waiting_for_owner', updated_at = now() where id = $1", [ctx.task.id]);
    await this.events.append(this.db, ctx.task.id, { kind: "owner_request", request: ownerRequestView(row) });
    await this.events.append(this.db, ctx.task.id, { kind: "state", state: "running", blockedReason: "waiting_for_owner" });
    await this.audit.append(ctx.agentId, "agent", "owner_request.created", { requestId: id, kind: "login", site, loginId: repair?.id ?? null });
    // The owner may have saved the login between the check above and the insert: the save looked for open requests
    // before this one existed, so look again now that it does.
    if (!repair) {
      const saved = await covering();
      if (saved) await this.tasks.loginSaved(ctx.agentId, saved);
    }
    if (repair?.otherSite) return { status: "ok", text: `Asked the owner to allow "${repair.name}" on ${site}. End your turn now; you continue when they allow it.` };
    return { status: "ok", text: "Asked the owner to save the login. End your turn now; you continue when it is saved." };
  }

  // --- Connected apps ------------------------------------------------------------------------------------------------

  private async connected(ctx: CallContext, work: () => Promise<string>): Promise<ToolOutcome> {
    if (!(await this.connectors.gmailAccount(ctx.agentId))) {
      return { status: "blocked", text: "Gmail is not connected. Call request_connection with app gmail and a one-line reason, then end your turn." };
    }
    try {
      return { status: "ok", text: clip(await work()) };
    } catch (error) {
      return { status: "failed", text: error instanceof Error ? error.message : String(error) };
    }
  }

  private async requestConnection(ctx: CallContext, input: McpToolInput<"request_connection">): Promise<ToolOutcome> {
    const account = await this.connectors.gmailAccount(ctx.agentId);
    if (account) return { status: "invalid", text: `Gmail is already connected (${account}). Use gmail_search, gmail_read and gmail_create_draft.` };
    if (!this.connectors.available().gmail) return { status: "failed", text: "This server cannot connect Gmail yet (no Google client is set up). Tell the owner." };
    const id = randomUUID();
    await this.tasks.fence(ctx.runId, "login");
    const row = await one<Parameters<typeof ownerRequestView>[0]>(
      this.db,
      "insert into owner_requests (id, task_id, run_id, kind, text, connector) values ($1, $2, $3, 'connect', $4, $5) returning *",
      [id, ctx.task.id, ctx.runId, input.reason, input.app],
    );
    await this.db.query("update tasks set blocked_reason = 'waiting_for_owner', updated_at = now() where id = $1", [ctx.task.id]);
    await this.events.append(this.db, ctx.task.id, { kind: "owner_request", request: ownerRequestView(row) });
    await this.events.append(this.db, ctx.task.id, { kind: "state", state: "running", blockedReason: "waiting_for_owner" });
    await this.audit.append(ctx.agentId, "agent", "owner_request.created", { requestId: id, kind: "connect", app: input.app });
    // A callback can finish after our first check but before this request exists.
    const connected = await this.connectors.gmailAccount(ctx.agentId);
    if (connected) await this.tasks.connectorConnected(ctx.agentId, input.app, connected);
    return { status: "ok", text: "Asked the owner to connect Gmail. End your turn now; you continue when it is connected." };
  }

  // --- Files ----------------------------------------------------------------------------------------------------------

  private async filesList(ctx: CallContext, input: McpToolInput<"files_list">): Promise<ToolOutcome> {
    const r = await this.supervisor.files(ctx.agentId, {
      op: "list",
      scope: input.scope,
      dir: input.dir,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    if (r.op === "error") return { status: "failed", text: `${r.code}: ${r.message}` };
    if (r.op !== "list") return { status: "failed", text: "unexpected helper result" };
    const ids = new Map<string, string>();
    if (input.scope === "downloads") {
      const rows = await this.db.query<{ rel_path: string; id: string }>("select rel_path, id from files where agent_id = $1 and scope = 'downloads'", [ctx.agentId]);
      for (const row of rows.rows) ids.set(row.rel_path, row.id);
    }
    const lines = r.entries.map((e) =>
      `${e.type === "dir" ? "dir " : "file"}  ${e.path}  ${e.type === "file" ? `${e.bytes} bytes  ` : ""}${e.modifiedAt}${ids.has(e.path) ? `  file_id ${ids.get(e.path)}` : ""}`,
    );
    if (r.nextCursor) lines.push(`more: call again with cursor ${r.nextCursor}`);
    return { status: "ok", text: lines.length > 0 ? lines.join("\n") : "(empty)" };
  }

  private async filesRead(ctx: CallContext, input: McpToolInput<"files_read">): Promise<ToolOutcome> {
    const r = await this.supervisor.files(ctx.agentId, {
      op: "read",
      scope: input.scope,
      path: input.path,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    if (r.op === "error") return { status: "failed", text: `${r.code}: ${r.message}` };
    if (r.op !== "read") return { status: "failed", text: "unexpected helper result" };
    if (r.kind === "image") return { status: "ok", text: `${input.path} (${r.mimeType})`, image: { data: r.content, mimeType: r.mimeType } };
    const more = r.nextOffset !== null ? `\n[continues: read again with offset ${r.nextOffset}]` : "";
    return { status: "ok", text: `${r.kind === "pdf_text" ? "PDF text of " : ""}${input.path}${r.totalLines !== null ? ` (${r.totalLines} lines)` : ""}\n${r.content}${more}` };
  }

  // --- Owner ----------------------------------------------------------------------------------------------------------

  private async requestDomains(ctx: CallContext, input: McpToolInput<"request_domains">): Promise<ToolOutcome> {
    // The owner approves sites, not hosts: auth.roblox.com and www.roblox.com are one request for *.roblox.com.
    let domains: string[];
    try {
      domains = sitePatterns(input.domains);
    } catch (error) {
      return { status: "invalid", text: `${error instanceof Error ? error.message : String(error)}. Ask for the site itself, such as example.com.` };
    }
    const sites = domains.map(siteLabel).join(", ");
    // One card per site per task: a site already in this task's open request is waited on, not asked again. Decided
    // requests, other tasks and other agents never count.
    const { created, waitIds } = await withTx(this.db, async (tx) => {
      // Serializes two calls of the same task, so both cannot insert the same site.
      await tx.query("select 1 from tasks where id = $1 for update", [ctx.task.id]);
      const open = await many<{ id: string; domains: string[] }>(
        tx,
        "select id, domains from domain_requests where agent_id = $1 and task_id = $2 and decided_at is null order by created_at",
        [ctx.agentId, ctx.task.id],
      );
      const asked = new Set(open.flatMap((row) => row.domains));
      const missing = domains.filter((pattern) => !asked.has(pattern));
      const waitIds = open.filter((row) => row.domains.some((pattern) => domains.includes(pattern))).map((row) => row.id);
      if (missing.length === 0) return { created: null, waitIds };
      const id = randomUUID();
      await tx.query(
        "insert into domain_requests (id, agent_id, task_id, run_id, domains, reason) values ($1, $2, $3, $4, $5, $6)",
        [id, ctx.agentId, ctx.task.id, ctx.runId, missing, input.reason],
      );
      await this.events.append(tx, ctx.task.id, { kind: "tool_call", tool: "request_domains", summary: `Asked to open ${missing.map(siteLabel).join(", ")}: ${input.reason}` });
      await this.events.append(tx, ctx.task.id, { kind: "domain_request", requestId: id as DomainRequestId, domains: missing, reason: input.reason });
      return { created: { id, domains: missing }, waitIds: [...waitIds, id] };
    });
    if (created) {
      await this.audit.append(ctx.agentId, "agent", "domain.requested", { requestId: created.id, domains: created.domains, reason: this.audit.textDigest(input.reason) });
    }
    const deadline = Date.now() + this.siteWaitMs;
    while (Date.now() < deadline) {
      const rows = await many<{ id: string; domains: string[]; decision: string | null; attended: boolean }>(
        this.db,
        "select id, domains, decision, attended from domain_requests where id = any($1::uuid[])",
        [waitIds],
      );
      if (rows.some((row) => row.decision === "skip")) {
        return { status: "blocked", text: `The owner wrote you a message instead of allowing ${sites}. End your turn now; their message starts your next turn.` };
      }
      if (rows.every((row) => row.decision !== null)) {
        await this.db.query("update domain_requests set reported = true where id = any($1::uuid[])", [waitIds]);
        const allowed = rows.some((row) => row.decision !== "refuse");
        return { status: allowed ? "ok" : "blocked", text: `${siteDecisionText(rows)}${allowed ? " Reload the page." : ""}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    // The request stays open: the run ends its turn and the owner's decision starts the next one, whenever it comes.
    await this.tasks.fence(ctx.runId, "domain_request");
    const parked = await this.db.query("update tasks set blocked_reason = 'domain_request', updated_at = now() where id = $1 and blocked_reason is null", [ctx.task.id]);
    if (parked.rowCount === 1) await this.events.append(this.db, ctx.task.id, { kind: "state", state: "running", blockedReason: "domain_request" });
    // A decision that landed between the last look and the fence found the run still working; resume on it now.
    await this.tasks.domainDecided(ctx.task.id);
    return { status: "blocked", text: "The owner has not decided yet. End your turn now; you continue when they decide." };
  }

  private async askOwner(ctx: CallContext, question: string): Promise<ToolOutcome> {
    const id = randomUUID();
    await this.tasks.fence(ctx.runId, "question");
    const row = await one<Parameters<typeof ownerRequestView>[0]>(
      this.db,
      "insert into owner_requests (id, task_id, run_id, kind, text) values ($1, $2, $3, 'question', $4) returning *",
      [id, ctx.task.id, ctx.runId, question],
    );
    await this.db.query("update tasks set blocked_reason = 'waiting_for_owner', updated_at = now() where id = $1", [ctx.task.id]);
    await this.events.append(this.db, ctx.task.id, { kind: "owner_request", request: ownerRequestView(row) });
    await this.events.append(this.db, ctx.task.id, { kind: "state", state: "running", blockedReason: "waiting_for_owner" });
    await this.audit.append(ctx.agentId, "agent", "owner_request.created", { requestId: id, kind: "question", text: this.audit.textDigest(question) });
    return { status: "ok", text: "Question sent to the owner. End your turn now; their answer starts your next turn." };
  }

  private async requestTakeover(ctx: CallContext, reason: string, whatToDo: string): Promise<ToolOutcome> {
    // A sign-in goes through the saved logins first; the owner is asked only for what a saved login cannot do.
    if (SIGN_IN_WORDS.test(`${reason} ${whatToDo}`)) {
      const tried = await maybeOne(
        this.db,
        "select 1 from browser_commands c join runs r on r.id = c.run_id where r.task_id = $1 and c.op like 'fill\\_%' limit 1",
        [ctx.task.id],
      );
      if (!tried) {
        return {
          status: "invalid",
          text:
            "For a sign-in, use the saved logins: logins_list, then browser_fill_login and browser_fill_code. No saved login for the " +
            "site: request_login. Ask for a takeover only for a step a saved login cannot do (a push or SMS code, a captcha, a " +
            "passkey), after you tried the saved login.",
        };
      }
    }
    const id = randomUUID();
    await this.tasks.fence(ctx.runId, "takeover");
    await this.computer.setLease(ctx.agentId, "paused", "agent");
    const row = await one<Parameters<typeof ownerRequestView>[0]>(
      this.db,
      "insert into owner_requests (id, task_id, run_id, kind, text, what_to_do) values ($1, $2, $3, 'takeover', $4, $5) returning *",
      [id, ctx.task.id, ctx.runId, reason, whatToDo],
    );
    await this.db.query("update tasks set blocked_reason = 'takeover', updated_at = now() where id = $1", [ctx.task.id]);
    await this.events.append(this.db, ctx.task.id, { kind: "owner_request", request: ownerRequestView(row) });
    await this.events.append(this.db, ctx.task.id, { kind: "state", state: "running", blockedReason: "takeover" });
    await this.audit.append(ctx.agentId, "agent", "owner_request.created", { requestId: id, kind: "takeover", reason: this.audit.textDigest(reason) });
    return { status: "ok", text: "Takeover requested. End your turn now; you continue when the owner hands control back." };
  }

  private async attachResult(ctx: CallContext, input: McpToolInput<"attach_result">): Promise<ToolOutcome> {
    const files: ResultFile[] = [];
    for (const fileId of input.file_ids) {
      const file = await maybeOne<{ id: string; name: string; bytes: number; sha256: string }>(
        this.db,
        "select id, name, bytes, sha256 from files where id = $1 and agent_id = $2",
        [fileId, ctx.agentId],
      );
      if (!file) return { status: "invalid", text: `No file with id ${fileId}. Use the file_id from download_status or files_list.` };
      files.push({ fileId: file.id as ResultFile["fileId"], name: file.name, bytes: file.bytes, sha256: file.sha256, scope: "downloads" });
    }
    for (const path of input.workspace_paths) {
      const stat = await this.supervisor.files(ctx.agentId, { op: "stat", scope: "workspace", path });
      if (stat.op === "error") return { status: "invalid", text: `${path}: ${stat.message}` };
      if (stat.op !== "stat" || stat.entry.type !== "file" || stat.sha256 === null) return { status: "invalid", text: `${path} is not a file I can attach.` };
      // The evidence is an immutable copy taken now: the workspace path can be overwritten later.
      const id = randomUUID();
      const copy = await this.evidence.capture(ctx.agentId, path, id);
      if (copy.sha256 !== stat.sha256) return { status: "failed", text: `${path} changed while it was being attached. Attach it again.` };
      await this.db.query(
        `insert into files (id, agent_id, scope, name, rel_path, bytes, sha256, mime_type, task_id, run_id, evidence)
         values ($1, $2, 'workspace', $3, $4, $5, $6, $7, $8, $9, true)`,
        [id, ctx.agentId, stat.entry.name, copy.relPath, copy.bytes, copy.sha256, mimeFor(stat.entry.name, copy.head), ctx.task.id, ctx.runId],
      );
      files.push({ fileId: id as ResultFile["fileId"], name: stat.entry.name, bytes: copy.bytes, sha256: copy.sha256, scope: "workspace" });
    }
    await this.tasks.attachResult(ctx.task.id, input.summary, files);
    return { status: "ok", text: `Attached ${files.length} file(s). Now give your final answer.` };
  }
}

export function mcpLocalAddressMatches(localAddress: string | undefined, mcpUrl: string | null): boolean {
  if (!localAddress || !mcpUrl) return false;
  const host = new URL(mcpUrl).hostname;
  return localAddress.replace(/^::ffff:/, "") === host;
}

async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}
