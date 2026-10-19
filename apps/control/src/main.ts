import pino from "pino";
import { context, startControl } from "./app.js";
import { diagnostic } from "./diagnostic.js";
import { loadConfig } from "./config.js";
import { serializeRequest } from "./logging.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.authorization"], serializers: { req: serializeRequest } });

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const config = loadConfig();
  if (command === "serve") {
    const control = await startControl(config, log, process.env.QUOKKABOT_WEB_ROOT ?? "/srv/web");
    const shutdown = (): void => {
      void control.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return;
  }
  if (command === "diagnostic") {
    await diagnostic(config, log, process.argv.slice(3));
    return;
  }
  const { db, auth, audit } = await context(config);
  try {
    if (command === "setup-link") {
      process.stdout.write(`${await auth.createSetupLink()}\n`);
      process.stdout.write("Open it within 30 minutes on the device that will hold your passkey.\n");
    } else if (command === "audit-verify") {
      let failed = false;
      for (const agent of config.agents) {
        const result = await audit.verify(agent.agentId);
        process.stdout.write(`${agent.name}: ${JSON.stringify(result)}\n`);
        if (!result.ok) failed = true;
      }
      process.exitCode = failed ? 1 : 0;
    } else if (command === "revoke-sessions") {
      await auth.revokeAllSessions();
      process.stdout.write("All owner sessions revoked. Create a setup link to sign in on a new device.\n");
    } else {
      process.stderr.write(`Unknown command ${command}. Commands: serve, setup-link, audit-verify, revoke-sessions, diagnostic\n`);
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error instanceof Error ? error.stack : String(error) }, "control plane failed");
  process.exit(1);
});
