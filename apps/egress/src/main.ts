import { readFile } from "node:fs/promises";
import { EgressConfig } from "@quokkabot/shared";
import { createEgress } from "./egress.js";

async function main(): Promise<void> {
  const path = process.env.QUOKKABOT_EGRESS_CONFIG;
  if (path === undefined || path.length === 0) throw new Error("QUOKKABOT_EGRESS_CONFIG must name the egress configuration file");
  const config = EgressConfig.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  const controlToken = (await readFile(config.control.tokenFile, "utf8")).trim();
  const egress = createEgress({ config, controlToken });
  await egress.start();
  const stop = (): void => {
    void egress.close().catch(() => { process.stderr.write("Egress shutdown failed\n"); process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Egress startup failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
