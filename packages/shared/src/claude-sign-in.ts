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

// The CLI may echo rejected input. Neither errors nor logs may carry the owner's one-time code.
export function claudeSignInError(message: string, code?: string): string {
  const clean = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return (code ? clean.replaceAll(code, "[redacted]") : clean)
    .replace(/[A-Za-z0-9_-]{8,256}#[A-Za-z0-9_-]{8,256}/g, "[redacted]").trim().slice(0, 200);
}
