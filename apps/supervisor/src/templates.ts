import { join } from "node:path";
import { claudeTaskEnv } from "@quokkabot/shared";
import type { SandboxName } from "@quokkabot/shared";
import type { AgentConfig, SupervisorConfig } from "./config.js";

export const SANDBOXES = ["cli", "tools", "browser"] as const;
export function containerName(agent: AgentConfig, sandbox: SandboxName): string { return `qb-${sandbox}-${agent.index}`; }
export function agentPath(config: SupervisorConfig, agent: AgentConfig, directory = ""): string { return join(config.dataRoot, "agents", String(agent.index), directory); }
export function cliEnvironment(agent: AgentConfig): string[] {
  return Object.entries({ ...claudeTaskEnv(agent.egressProxy.cli), NO_PROXY: agent.controlAddress.cli }).map(([key, value]) => `${key}=${value}`);
}
export function networkBody(agent: AgentConfig, kind: "cli" | "browser") {
  const network = agent.networks[kind];
  return { Name: network.name, Driver: "bridge", Internal: true, EnableIPv6: false, IPAM: { Driver: "default", Config: [{ Subnet: network.subnet }] } };
}
export function containerBody(config: SupervisorConfig, agent: AgentConfig, sandbox: SandboxName, secrets?: { selkies: string; browser: string }) {
  const limits = config.limits[sandbox];
  const host = {
    Runtime: config.runtime,
    RestartPolicy: { Name: "no" },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Memory: limits.memoryMb * 1024 * 1024,
    NanoCpus: Math.round(limits.cpus * 1_000_000_000),
    PidsLimit: limits.pids,
    ReadonlyRootfs: sandbox !== "browser",
    Tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m" },
  };
  // A fixed hostname: Chrome's profile lock records it, and a recreated container must recognise its own stale lock.
  const base = { Image: config.images[sandbox], Hostname: containerName(agent, sandbox), Labels: { "quokkabot.agent": agent.agentId, "quokkabot.sandbox": sandbox } };
  if (sandbox === "tools") return { ...base, User: "1000:1000", Cmd: ["sleep", "infinity"], HostConfig: {
    ...host, NetworkMode: "none", Binds: [`${agentPath(config, agent, "workspace")}:/workspace:rw`, `${agentPath(config, agent, "downloads")}:/downloads:ro`],
  } };
  const network = agent.networks[sandbox];
  const networking = { EndpointsConfig: { [network.name]: { IPAMConfig: { IPv4Address: network.address } } } };
  if (sandbox === "cli") return { ...base, User: "1000:1000", Cmd: ["sleep", "infinity"], Env: cliEnvironment(agent), NetworkingConfig: networking, HostConfig: {
    ...host, NetworkMode: network.name, Dns: [], Binds: [`${agentPath(config, agent, "cli-state")}:/home/claude:rw`, `${agentPath(config, agent, "run")}:/run/quokkabot:rw`],
  } };
  if (!secrets) throw new Error("Browser secrets are required to create the browser sandbox");
  return { ...base, Env: ["PUID=1000", "PGID=1000", "TZ=Etc/UTC", `QUOKKABOT_PROXY=${agent.egressProxy.browser}`, `SELKIES_MASTER_TOKEN=${secrets.selkies}`, `QUOKKABOT_BROWSER_SERVICE_TOKEN=${secrets.browser}`, `SELKIES_ALLOWED_ORIGINS=${new URL(config.viewOrigin).origin}`], NetworkingConfig: networking, HostConfig: {
    ...host, NetworkMode: network.name, CapAdd: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"], ShmSize: config.limits.browser.shmMb * 1024 * 1024,
    Binds: [`${agentPath(config, agent, "browser-profile")}:/config:rw`, `${agentPath(config, agent, "staging")}:/staging:rw`],
  } };
}
