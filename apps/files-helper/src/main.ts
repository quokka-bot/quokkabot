#!/usr/bin/env node
import { exportFile, handle } from "./handle.js";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "export")) {
    throw new Error("Usage: qb-files [export]");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (args[0] === "export") {
    await exportFile(input, process.stdout);
  } else {
    const result = await handle(input);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result)}\n`, (error) => { if (error) reject(error); else resolve(); });
    });
  }
} catch (error) {
  process.stderr.write(`qb-files: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
