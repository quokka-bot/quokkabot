import { z } from "zod";

export function isClaudeSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https://claude.com", "https://claude.ai"].includes(url.origin)
      && !url.username && !url.password && url.pathname.endsWith("/oauth/authorize");
  } catch { return false; }
}

export const ClaudeSignInCode = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{8,256}#[A-Za-z0-9_-]{8,256}$/) }).strict();
export const ClaudeSignInStart = z.object({ signInId: z.uuid(), url: z.string().refine(isClaudeSignInUrl, "Invalid Claude sign-in URL") });
export type ClaudeSignInStart = z.infer<typeof ClaudeSignInStart>;
export const ClaudeSignInStatus = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullable().default(null),
  subscriptionType: z.string().nullable().default(null),
});
export type ClaudeSignInStatus = z.infer<typeof ClaudeSignInStatus>;

// A long-lived Claude subscription token from `claude setup-token` (inference only, valid for a year). The supervisor
// keeps one for all agents and hands it only to the CLI's own processes, in their environment.
export const ClaudeOAuthToken = z.string().regex(/^sk-ant-oat01-[A-Za-z0-9_-]{32,512}$/);

// The Claude sign-in all agents share, as the supervisor and the owner API report it. The token never appears here.
export const ClaudeSignInView = z.object({ signedIn: z.boolean(), signedInAt: z.iso.datetime().nullable() }).strict();
export type ClaudeSignInView = z.infer<typeof ClaudeSignInView>;

// The CLI may echo rejected input. Neither errors nor logs may carry the owner's one-time code or a token.
export function claudeSignInError(message: string, code?: string): string {
  const clean = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return (code ? clean.replaceAll(code, "[redacted]") : clean)
    .replace(/[A-Za-z0-9_-]{8,256}#[A-Za-z0-9_-]{8,256}/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").trim().slice(0, 200);
}
