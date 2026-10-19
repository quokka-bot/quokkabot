import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const server = await createServer(await loadConfig());
  process.stdout.write(JSON.stringify({ event: "supervisor_listening", socketPath: server.supervisor.config.socketPath }) + "\n");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch(() => { process.exitCode = 1; });
  });
} catch (error) {
  // Config validation errors can contain secrets. Log the error class, never the raw object.
  process.stderr.write(JSON.stringify({ event: "supervisor_startup_failed", error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error && error.name !== "ZodError" && !(error instanceof SyntaxError) ? error.message : "Invalid supervisor configuration or persisted state" }) + "\n");
  process.exitCode = 1;
}
