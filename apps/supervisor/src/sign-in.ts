import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isClaudeSignInUrl, claudeSignInError } from "@quokkabot/shared";
import { dockerOutput } from "./docker.js";
import { ApiError } from "./supervisor.js";

export interface SignIn {
  id: string;
  agentId: string;
  execId: string;
  stream: Duplex;
  url: Promise<string>;
  done: Promise<number | null>;
  failure: string | null;
  submitting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function signInUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) if (isClaudeSignInUrl(match[0])) return match[0];
  return null;
}

export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(400, "sign_in_timeout", message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// Only the URL and a bounded failure line leave this reader. Authentication output is never sent to the run store.
export function readSignIn(id: string, agentId: string, execId: string, stream: Duplex, wait: () => Promise<number | null>, expire: (id: string) => void): SignIn {
  let accept!: (url: string) => void;
  let refuse!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => { accept = resolve; refuse = reject; });
  void url.catch(() => undefined);
  const record: SignIn = { id, agentId, execId, stream, url, done: Promise.resolve(null), failure: null, submitting: false, timer: setTimeout(() => expire(id), 10 * 60_000) };
  record.timer.unref();
  record.done = (async () => {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" };
    const line = (name: "stdout" | "stderr", value: string) => {
      if (name === "stdout") { const found = signInUrl(value); if (found) accept(found); }
      const failure = /Login failed:[^\r\n]*/.exec(value)?.[0];
      if (failure) record.failure = claudeSignInError(failure);
    };
    try {
      for await (const chunk of dockerOutput(stream)) {
        const name = chunk.stream;
        pending[name] += decoders[name].write(chunk.data);
        if (pending[name].length > 65_536) throw new Error("Sign-in output exceeded the line limit");
        const lines = pending[name].split("\n");
        pending[name] = lines.pop()!;
        for (const value of lines) line(name, value);
      }
      for (const name of ["stdout", "stderr"] as const) line(name, pending[name] + decoders[name].end());
      const result = await wait();
      refuse(new ApiError(400, "sign_in_failed", record.failure ?? "Claude sign-in ended before returning a URL"));
      return result;
    } catch {
      const error = new ApiError(400, "sign_in_failed", "Claude sign-in disconnected. Start again.");
      refuse(error);
      throw error;
    }
  })();
  void record.done.catch(() => undefined);
  return record;
}
