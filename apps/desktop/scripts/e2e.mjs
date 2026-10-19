import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.QUOKKABOT_E2E_SERVER) throw new Error("Set QUOKKABOT_E2E_SERVER to a running, signed-out Quokka Bot server origin.");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
async function run(args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron test command failed (${signal ?? code}).`)));
  });
}
await run([join(root, "scripts/build.mjs")], { ...process.env, QUOKKABOT_E2E_BUILD: "1" });
try {
  await run([join(dirname(require.resolve("playwright/package.json")), "cli.js"), "test", "--config", "test/e2e/playwright.config.ts", ...process.argv.slice(2)], process.env);
} finally {
  // Leave electron . pointing at an ordinary development build after tests, even after a failure.
  await run([join(root, "scripts/build.mjs")], { ...process.env, QUOKKABOT_E2E_BUILD: "0" });
}
