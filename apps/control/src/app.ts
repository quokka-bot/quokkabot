import pg from "pg";
import type http from "node:http";
import type { Logger } from "pino";
import { AuditLog } from "./audit.js";
import { AgentSlots } from "./agents.js";
import { Auth } from "./auth.js";
import { BrowserServiceClient, EgressClient, SelkiesClient, SupervisorClient } from "./clients.js";
import { type AgentHandles, ComputerService } from "./computer.js";
import { agentSecrets, type ControlConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { TaskEvents } from "./events.js";
import { DesktopLinks } from "./desktop.js";
import { Vault } from "./vault.js";
import { Connectors } from "./connectors.js";
import { EvidenceStore, FileBroker } from "./files.js";
import { buildServer } from "./http.js";
import { McpEndpoint } from "./mcp.js";
import { PolicyService } from "./policy.js";
import { TaskService } from "./tasks.js";

export interface ControlHandles {
  tasks: TaskService;
  computer: ComputerService;
  policy: PolicyService;
  close(): Promise<void>;
}

export async function context(config: ControlConfig) {
  await migrate(config);
  const db = createPool(config, "app");
  const audit = new AuditLog(db, config.secrets.auditHmacKey);
  const slots = new AgentSlots(db, config, audit);
  await slots.initialize();
  const agentIds = (): Promise<string[]> => slots.ids();
  const auth = new Auth(db, config, audit, agentIds);
  return { db, audit, auth, agentIds, slots };
}

export function clientsFor(config: ControlConfig): {
  supervisor: SupervisorClient;
  egress: EgressClient;
  handles: (agentId: string) => AgentHandles;
} {
  const supervisor = new SupervisorClient(config.supervisorSocket, config.secrets.supervisorToken);
  const egress = new EgressClient(config.egressUrl, config.secrets.egressToken);
  const handleMap = new Map<string, AgentHandles>();
  for (const agent of config.agents) {
    const secrets = agentSecrets(config, agent.agentId);
    handleMap.set(agent.agentId, {
      browser: new BrowserServiceClient(agent.browserServiceUrl, secrets.browserServiceToken),
      selkies: new SelkiesClient(agent.selkiesUrl, secrets.selkiesMasterToken),
    });
  }
  const handles = (agentId: string): AgentHandles => {
    const found = handleMap.get(agentId);
    if (!found) throw new Error(`unknown agent ${agentId}`);
    return found;
  };
  return { supervisor, egress, handles };
}

export async function startControl(config: ControlConfig, log: Logger, webRoot: string): Promise<ControlHandles> {
  const { db, audit, auth, agentIds, slots } = await context(config);
  const { supervisor, egress, handles } = clientsFor(config);

  const events = new TaskEvents(db);
  await events.listen(
    () =>
      new pg.Client({
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.appUser,
        password: config.secrets.dbAppPassword,
      }),
  );
  const policy = new PolicyService(db, egress, audit, log, () => slots.configuredIds, slots);
  for (const agentId of slots.configuredIds) await policy.ensureDefaultRules(agentId);
  await policy.push().catch((error: unknown) => log.error({ err: String(error) }, "initial policy push failed"));
  void policy.runDecisionLoop();

  const computer = new ComputerService(db, supervisor, egress, policy, audit, handles, log, slots);
  const tasks = new TaskService(db, events, audit, supervisor, computer, policy, log, agentIds, slots);
  const broker = new FileBroker(db, audit, events, log);
  for (const agent of config.agents) await broker.cleanIncoming(agent.downloadsDir);

  const evidence = new EvidenceStore(supervisor, (agentId) => {
    const agent = config.agents.find((a) => a.agentId === agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    return agent.downloadsDir;
  });
  const vault = new Vault(db, config.secrets.vaultKey, audit, async (agentId) => { await slots.require(agentId); });
  const connectors = new Connectors(db, config.secrets.vaultKey, audit, config.appOrigin, config.secrets.googleClient,
    slots, log);
  const mcp = new McpEndpoint(db, tasks, events, audit, supervisor, computer, policy, handles, evidence, vault, connectors, log,
    (agentId) => config.agents.find((agent) => agent.agentId === agentId)?.mcpUrl ?? null);
  const mcpServers: http.Server[] = [];
  for (const agent of config.agents) {
    const url = new URL(agent.mcpUrl);
    mcpServers.push(await mcp.listen(url.hostname, Number(url.port || 80)));
  }

  const desktopLinks = new DesktopLinks(db, audit, config.appOrigin, agentIds);
  const { app } = await buildServer({
    config,
    slots,
    desktopLinks,
    vault,
    connectors,
    db,
    auth,
    audit,
    tasks,
    events,
    computer,
    policy,
    supervisor,
    drainTools: (agentId) => mcp.drainAgent(agentId),
    handles,
    log,
    webRoot,
  });
  const [host, port] = config.listen.split(":") as [string, string];
  await app.listen({ host, port: Number(port) });

  await tasks.recover();

  // Background loops: downloads into Downloads, owner lease expiry, policy refresh, dispatch.
  const sweepTimer = setInterval(() => {
    for (const agent of config.agents) {
      if (!slots.knownIds.has(agent.agentId)) continue;
      void slots.exclusive(agent.agentId, async () => {
        const row = await slots.require(agent.agentId);
        if (row.removing_at) return;
        if (await computer.isRunning(agent.agentId)) await broker.sweep(agent.agentId, agent.downloadsDir, handles(agent.agentId).browser);
      })
        .catch((error: unknown) => log.debug({ err: String(error) }, "download sweep skipped"));
    }
  }, 2000);
  const leaseTimer = setInterval(() => void computer.expireLeases().catch((error: unknown) => log.warn({ err: String(error) }, "lease expiry failed")), 10_000);
  const policyTimer = setInterval(() => void policy.push().catch((error: unknown) => log.warn({ err: String(error) }, "policy refresh failed")), 60_000);
  const kickTimer = setInterval(() => tasks.kick(), 5000);
  const attendedTimer = setInterval(() => {
    for (const agent of config.agents) {
      if (!slots.knownIds.has(agent.agentId)) continue;
      void slots.exclusive(agent.agentId, async () => {
        const row = await slots.require(agent.agentId);
        if (!row.removing_at) await computer.clearAttendedData(agent.agentId);
      }).catch((error: unknown) => log.debug({ err: String(error) }, "attended data clearing pending"));
    }
  }, 60_000);
  const reconcileTimer = setInterval(() => void tasks.reconcile().catch((error: unknown) => log.warn({ err: String(error) }, "reconcile failed")), 30_000);

  const timers = [sweepTimer, leaseTimer, policyTimer, kickTimer, reconcileTimer, attendedTimer];
  log.info({ app: config.appOrigin, view: config.viewOrigin, mcp: config.agents.map((agent) => agent.mcpUrl) }, "quokkabot control plane up");
  return {
    tasks,
    computer,
    policy,
    async close() {
      for (const timer of timers) clearInterval(timer);
      tasks.stop();
      policy.stop();
      for (const server of mcpServers) server.close();
      await app.close();
      await events.close();
      await db.end();
    },
  };
}
