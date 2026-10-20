import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ClaudeOAuthToken, isClaudeSignInUrl, claudeSignInError } from "@quokkabot/shared";
import { dockerOutput } from "./docker.js";
import { ApiError } from "./supervisor.js";

export interface SignIn {
  id: string;
  agentId: string;
  execId: string;
  stream: Duplex;
  url: Promise<string>;
  // The token, as soon as the CLI shows it. Rejects when the CLI shows an error (it then waits for a retry instead of
  // exiting) or exits without a token.
  token: Promise<string>;
  failure: string | null;
  submitting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

// `claude setup-token` draws a terminal UI. It shows the sign-in URL as an OSC 8 hyperlink, which carries the whole URL
// however the terminal wraps the visible text.
export function signInUrl(raw: string): string | null {
  for (const match of raw.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) if (isClaudeSignInUrl(match[1]!)) return match[1]!;
  return null;
}

// The screen as text: cursor-forward moves become spaces, every other escape sequence goes.
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_match, count: string) => " ".repeat(Math.min(Number(count || "1"), 1000)))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
}

const SUCCESS = "Long-lived authentication token created successfully";

// The token appears once the CLI reports success. A token counts only once a character after it has arrived, and every
// copy on the screen must be the same.
export function signInToken(screen: string): string | null {
  const at = screen.indexOf(SUCCESS);
  if (at === -1) return null;
  const tokens = new Set([...screen.slice(at).matchAll(/sk-ant-oat01-[A-Za-z0-9_-]+(?=[^A-Za-z0-9_-])/g)].map((match) => match[0]));
  const [token] = tokens;
  if (tokens.size !== 1 || !ClaudeOAuthToken.safeParse(token).success) return null;
  return token!;
}

export function signInFailure(screen: string): string | null {
  const line = /(?:OAuth error|Login failed):[^\n]*/.exec(screen)?.[0];
  return line ? claudeSignInError(line.replace(/\s*Press Enter to retry\.?.*$/, "")) : null;
}

export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(400, "sign_in_timeout", message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// Only the URL, the token (for the token store) and a bounded failure line leave this reader. The terminal output is
// never logged or sent to the run store.
export function readSignIn(id: string, agentId: string, execId: string, stream: Duplex, wait: () => Promise<number | null>, expire: (id: string) => void): SignIn {
  let acceptUrl!: (url: string) => void;
  let refuseUrl!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => { acceptUrl = resolve; refuseUrl = reject; });
  void url.catch(() => undefined);
  let acceptToken!: (token: string) => void;
  let refuseToken!: (error: Error) => void;
  const token = new Promise<string>((resolve, reject) => { acceptToken = resolve; refuseToken = reject; });
  void token.catch(() => undefined);
  const record: SignIn = { id, agentId, execId, stream, url, token, failure: null, submitting: false, timer: setTimeout(() => expire(id), 10 * 60_000) };
  record.timer.unref();
  void (async () => {
    const decoder = new StringDecoder("utf8");
    let raw = "";
    const scan = () => {
      const link = signInUrl(raw);
      if (link) acceptUrl(link);
      const screen = screenText(raw);
      const shown = signInToken(screen);
      if (shown) acceptToken(shown);
      const failure = signInFailure(screen);
      if (failure && record.failure === null) {
        record.failure = failure;
        refuseToken(new ApiError(400, "sign_in_failed", failure));
      }
    };
    try {
      for await (const chunk of dockerOutput(stream, true)) {
        raw += decoder.write(chunk.data);
        if (raw.length > 262_144) throw new Error("Sign-in output exceeded its limit");
        scan();
      }
      raw += decoder.end();
      scan();
      await wait();
      refuseUrl(new ApiError(400, "sign_in_failed", record.failure ?? "Claude sign-in ended before returning a URL"));
      refuseToken(new ApiError(400, "sign_in_failed", record.failure ?? "Claude sign-in failed. Start again."));
    } catch {
      const error = new ApiError(400, "sign_in_failed", "Claude sign-in disconnected. Start again.");
      refuseUrl(error);
      refuseToken(error);
    }
  })();
  return record;
}
