import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
};
export interface RunOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number }
export interface ManagedProcess {
  exited: Promise<void>;
  kill(): void;
}
export interface ProcessRunner {
  run(executable: string, argv: readonly string[], options: RunOptions): Promise<ProcessResult>;
  start(executable: string, argv: readonly string[], options: Omit<RunOptions, "timeoutMs">): ManagedProcess;
}
export class UncertainProcessError extends Error {}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // The CLI's daemon may still be acting after the client dies. Do not retry the command.
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export const nodeProcessRunner: ProcessRunner = {
  run(executable, argv, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...argv], {
        shell: false, detached: true, env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let uncertain: string | undefined;
      const stop = (message: string) => { uncertain = message; killTree(child); };
      const abort = () => stop("agent-browser process cancelled for control lease change");
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(() => stop("agent-browser process timed out"), options.timeoutMs);
      const collect = (chunk: Buffer, output: "stdout" | "stderr") => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { stop("agent-browser output exceeded 8 MiB"); return; }
        if (output === "stdout") stdout.push(chunk);
        else stderr.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.once("error", () => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        reject(new UncertainProcessError("agent-browser could not start"));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (uncertain !== undefined || signal !== null || code === null) {
          reject(new UncertainProcessError(uncertain ?? "agent-browser process crashed"));
        } else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code });
      });
    });
  },
  start(executable, argv, options) {
    const child = spawn(executable, [...argv], {
      shell: false, detached: true, env: options.env, cwd: options.cwd, stdio: "ignore",
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Chrome could not start")));
      child.once("exit", () => resolve());
    });
    return { exited, kill: () => killTree(child) };
  },
};

// Keep the complete ordered launch template here. Proxy is the only substituted argument.
export const CHROME_PROFILE_DIR = "/config/chrome-profile";
export const CHROME_ARGV = Object.freeze([
  `--user-data-dir=${CHROME_PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check",
  "--start-maximized", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
  "--proxy-server=<QUOKKABOT_PROXY>", "--proxy-bypass-list=<-loopback>",
  "--disable-background-networking", "--disable-component-update",
  "--disable-features=BackForwardCache",
  "--disable-sync", "--password-store=basic", "--test-type",
]);
export function chromeArgv(proxy: string): string[] {
  const parsed = new URL(proxy);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("QUOKKABOT_PROXY must be an http proxy origin without credentials");
  }
  return CHROME_ARGV.map((argument) => argument.replace("<QUOKKABOT_PROXY>", proxy));
}
export const AGENT_BROWSER_ARGV = Object.freeze([
  "--cdp", "9222", "--session", "quokkabot", "--json",
  "--action-policy", "/etc/quokkabot/agent-browser-policy.json",
]);
