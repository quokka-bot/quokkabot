import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { AgentId } from "@quokkabot/shared";

const AbsolutePath = z.string().min(1).refine((value) => isAbsolute(value) && normalize(value) === value && !value.includes("\0"), "a normalized absolute path");
const Network = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
  subnet: z.cidrv4(),
  address: z.ipv4(),
}).strict();
const ProxyUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && z.ipv4().safeParse(url.hostname).success && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
}, "an HTTP proxy URL with an IPv4 address and without credentials, path or query");
const Resources = z.object({ memoryMb: z.number().int().positive(), cpus: z.number().positive().max(1024), pids: z.number().int().positive() }).strict();
const Image = z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/, "an image pinned by sha256 digest");

export const SupervisorConfig = z.object({
  socketPath: AbsolutePath,
  tokenFile: AbsolutePath,
  dockerSocket: AbsolutePath,
  dataRoot: AbsolutePath,
  dataMarker: z.string().regex(/^[a-zA-Z0-9_.-]+$/).refine((value) => value !== "." && value !== ".."),
  runtime: z.enum(["runsc", "runc"]),
  // The viewer origin: the only Origin Selkies accepts on its WebSocket (the control plane's viewer proxy sends it).
  viewOrigin: z.url().refine((u) => /^https:\/\/|^http:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/.test(new URL(u).origin), "an https origin"),
  images: z.object({ cli: Image, tools: Image, browser: Image }).strict(),
  agents: z.array(z.object({
    agentId: AgentId,
    index: z.number().int().min(1).max(65535),
    networks: z.object({ cli: Network, browser: Network }).strict(),
    egressProxy: z.object({ cli: ProxyUrl, browser: ProxyUrl }).strict(),
    controlAddress: z.object({ cli: z.ipv4() }).strict(),
    secretsDir: AbsolutePath,
  }).strict()).min(1),
  limits: z.object({ cli: Resources, tools: Resources, browser: Resources.extend({ shmMb: z.number().int().positive() }).strict() }).strict(),
}).strict().superRefine((config, context) => {
  for (const key of ["agentId", "index"] as const) {
    if (new Set(config.agents.map((agent) => agent[key])).size !== config.agents.length) context.addIssue({ code: "custom", message: `Duplicate agent ${key}` });
  }
  const names = config.agents.flatMap((agent) => [agent.networks.cli.name, agent.networks.browser.name]);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "Sandbox network names must be unique" });
  const ipv4Number = (address: string) => address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const agent of config.agents) {
    for (const kind of ["cli", "browser"] as const) {
      const network = agent.networks[kind];
      const [base, prefix] = network.subnet.split("/");
      const size = 2 ** (32 - Number(prefix));
      const start = ipv4Number(base!);
      const end = start + size - 1;
      const address = ipv4Number(network.address);
      const proxy = ipv4Number(new URL(agent.egressProxy[kind]).hostname);
      if (start % size !== 0 || address <= start || address >= end || proxy <= start || proxy >= end || proxy === address) context.addIssue({ code: "custom", message: `Invalid address or proxy for ${network.name}` });
      if (kind === "cli") {
        const control = ipv4Number(agent.controlAddress.cli);
        if (control <= start || control >= end || control === address || control === proxy) context.addIssue({ code: "custom", message: `Invalid control address for ${network.name}` });
      }
      if (ranges.some((range) => range.start <= end && start <= range.end)) context.addIssue({ code: "custom", message: "Sandbox subnets must not overlap" });
      ranges.push({ start, end });
    }
  }
});
export type SupervisorConfig = z.infer<typeof SupervisorConfig>;
export type AgentConfig = SupervisorConfig["agents"][number];

export async function loadConfig(file = process.env.QUOKKABOT_SUPERVISOR_CONFIG): Promise<SupervisorConfig> {
  if (!file) throw new Error("QUOKKABOT_SUPERVISOR_CONFIG must name a JSON configuration file");
  return SupervisorConfig.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function requireDataMarker(config: SupervisorConfig): Promise<void> {
  const root = await lstat(config.dataRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("dataRoot must be a real directory on the encrypted volume");
  const marker = await lstat(`${config.dataRoot}/${config.dataMarker}`).catch((error: unknown) => {
    throw new Error("Encrypted data volume marker is missing; refusing startup", { cause: error });
  });
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Encrypted data volume marker must be a regular file");
}
