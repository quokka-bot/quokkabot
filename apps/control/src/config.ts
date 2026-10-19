import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentId } from "@quokkabot/shared";
import { z } from "zod";

function isAllowedOrigin(origin: string): boolean {
  const url = new URL(origin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost"));
}

export const ControlConfigFile = z
  .object({
    appOrigin: z.url().refine(isAllowedOrigin, "an https origin (http only for *.localhost in development)"),
    viewOrigin: z.url().refine(isAllowedOrigin, "an https origin (http only for *.localhost in development)"),
    ownerName: z.string().min(1).max(80),
    // Optional contact address shown on the public About and Privacy pages.
    publicContact: z.email().optional(),
    // iPhone app builds allowed to use native passkeys on this domain ("<team id>.<bundle id>"), served in
    // /.well-known/apple-app-site-association. Only a build that names this domain in its entitlements can use it.
    appleAppIds: z.array(z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)).max(10).default([]),
    dataRoot: z.string().startsWith("/"),
    secretsDir: z.string().startsWith("/"),
    listen: z.string().regex(/^[0-9.]+:[0-9]{1,5}$/).default("0.0.0.0:8080"),
    database: z.object({
      host: z.string(),
      port: z.number().int(),
      name: z.string(),
      ownerUser: z.string(),
      appUser: z.string(),
    }),
    supervisorSocket: z.string().startsWith("/"),
    egressUrl: z.url(),
    agents: z
      .array(
        z.object({
          agentId: AgentId,
          index: z.number().int().min(1).max(99),
          name: z.string().min(1).max(80),
          mcpUrl: z.url().refine((value) => {
            const url = new URL(value);
            return url.protocol === "http:" && /^[0-9.]+$/.test(url.hostname) && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash && url.hostname !== "0.0.0.0";
          }, "an HTTP /mcp URL on a specific IPv4 address"),
          browserServiceUrl: z.url(),
          selkiesUrl: z.url(),
          downloadsDir: z.string().startsWith("/"),
        }),
      )
      .min(1),
    // Optional: a directory holding the signed desktop app builds and their update manifests, served at /desktop/.
    desktopRoot: z.string().startsWith("/").optional(),
    defaultModel: z.string().default("claude-opus-5-5"),
    defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("xhigh"),
  })
  .strict().superRefine((config, context) => {
    for (const key of ["agentId", "index", "mcpUrl"] as const) {
      if (new Set(config.agents.map((agent) => agent[key])).size !== config.agents.length) context.addIssue({ code: "custom", message: `Duplicate agent ${key}` });
    }
    if (new Set(config.agents.map((agent) => new URL(agent.mcpUrl).hostname)).size !== config.agents.length) context.addIssue({ code: "custom", message: "Each slot needs its own MCP listener address" });
    if (config.agents.some((agent) => agent.index > config.agents.length)) context.addIssue({ code: "custom", message: "Agent indexes must cover slots 1..N" });
  });
export type ControlConfigFile = z.infer<typeof ControlConfigFile>;
export type AgentConfig = ControlConfigFile["agents"][number];

export interface Secrets {
  dbOwnerPassword: string;
  dbAppPassword: string;
  sessionSecret: Buffer;
  auditHmacKey: Buffer;
  supervisorToken: string;
  egressToken: string;
  // 32 bytes. Encrypts the login vault; never stored in the database.
  vaultKey: Buffer;
  // Optional: the Google OAuth client for connecting Gmail ({"client_id", "client_secret"}). Absent: no Gmail.
  googleClient: { clientId: string; clientSecret: string } | null;
  perAgent: Map<string, { selkiesMasterToken: string; browserServiceToken: string }>;
}

export interface ControlConfig extends ControlConfigFile {
  secrets: Secrets;
  appHost: string;
  viewHost: string;
}

function readSecret(dir: string, name: string): string {
  const value = readFileSync(join(dir, name), "utf8").trim();
  if (value.length < 16) throw new Error(`secret ${name} is missing or shorter than 16 characters`);
  return value;
}

function readGoogleClient(dir: string): { clientId: string; clientSecret: string } | null {
  let text: string;
  try {
    text = readFileSync(join(dir, "google_oauth_client"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as { client_id?: unknown; client_secret?: unknown };
  if (typeof parsed.client_id !== "string" || typeof parsed.client_secret !== "string" || !parsed.client_id || !parsed.client_secret) {
    throw new Error("secret google_oauth_client must be JSON with client_id and client_secret");
  }
  return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
}

function readVaultKey(dir: string): Buffer {
  const text = readFileSync(join(dir, "vault_key"), "utf8").trim();
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error("secret vault_key must be 32 bytes, base64 encoded");
  return key;
}

export function loadConfig(path = process.env.QUOKKABOT_CONTROL_CONFIG ?? "/etc/quokkabot/control.json"): ControlConfig {
  const file = ControlConfigFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const dir = file.secretsDir;
  const perAgent = new Map<string, { selkiesMasterToken: string; browserServiceToken: string }>();
  for (const agent of file.agents) {
    perAgent.set(agent.agentId, {
      selkiesMasterToken: readSecret(dir, `agent-${agent.index}/selkies_master_token`),
      browserServiceToken: readSecret(dir, `agent-${agent.index}/browser_service_token`),
    });
  }
  const secrets: Secrets = {
    dbOwnerPassword: readSecret(dir, "db_owner_password"),
    dbAppPassword: readSecret(dir, "db_app_password"),
    sessionSecret: Buffer.from(readSecret(dir, "session_secret"), "utf8"),
    auditHmacKey: Buffer.from(readSecret(dir, "audit_hmac_key"), "utf8"),
    supervisorToken: readSecret(dir, "supervisor_token"),
    egressToken: readSecret(dir, "egress_token"),
    vaultKey: readVaultKey(dir),
    googleClient: readGoogleClient(dir),
    perAgent,
  };
  return {
    ...file,
    // Origins are compared with the Origin header, which never has a trailing slash.
    appOrigin: new URL(file.appOrigin).origin,
    viewOrigin: new URL(file.viewOrigin).origin,
    secrets,
    appHost: new URL(file.appOrigin).host,
    viewHost: new URL(file.viewOrigin).host,
  };
}

export function agentSecrets(config: ControlConfig, agentId: string): { selkiesMasterToken: string; browserServiceToken: string } {
  const found = config.secrets.perAgent.get(agentId);
  if (!found) throw new Error(`no secrets for agent ${agentId}`);
  return found;
}
