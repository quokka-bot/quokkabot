import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserCdp } from "./cdp.js";
import { nodeProcessRunner, systemClock } from "./runtime.js";
import { createBrowserService } from "./service.js";
export { createBrowserService } from "./service.js";
export { CHROME_ARGV, chromeArgv, AGENT_BROWSER_ARGV } from "./runtime.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function main(): Promise<void> {
  const service = await createBrowserService({
    token: required("QUOKKABOT_BROWSER_SERVICE_TOKEN"), chrome: required("QUOKKABOT_CHROME"),
    agentBrowser: required("QUOKKABOT_AGENT_BROWSER"), screenResize: required("QUOKKABOT_SCREEN_RESIZE"), proxy: required("QUOKKABOT_PROXY"),
    runner: nodeProcessRunner, cdp: new BrowserCdp(), clock: systemClock,
    roots: { staging: "/staging", scratch: "/tmp/quokkabot-browser", daemon: join(homedir(), ".agent-browser") },
    // Do not forward unrelated service credentials, provider settings, or plugin configuration to children.
    env: { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
  await service.start();
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(7800, "0.0.0.0", resolve);
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void service.shutdown().then(() => {
      service.server.close();
    }).catch(() => { process.exitCode = 1; service.server.close(); });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Browser service startup failed");
    process.exitCode = 1;
  });
}
