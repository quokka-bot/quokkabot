import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ClaudeSignInCode, type AgentSummary, type ClaudeSignInStatus } from "@quokkabot/shared";
import { api, errorMessage } from "./api.js";
import { openConnectTab } from "./apps.js";

export function claudeAccount(email: string | null, plan: string | null): string {
  return [email, plan ? plan[0]?.toUpperCase() + plan.slice(1) : null].filter(Boolean).join(" · ");
}

export function ClaudeSignInCard({ agent }: { agent: AgentSummary }) {
  const client = useQueryClient();
  const [stage, setStage] = useState<"ready" | "starting" | "code" | "finishing" | "error" | "success">("ready");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeSignInStatus | null>(null);
  const session = useRef<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (session.current) void api.cancelClaudeSignIn(session.current).catch(() => undefined);
    };
  }, []);

  async function start(tab: Window | null) {
    if (pending.current) { tab?.close(); return; }
    pending.current = true;
    setStage("starting"); setError(null); setCode("");
    try {
      const result = await api.startClaudeSignIn(agent.id);
      if (!mounted.current) { tab?.close(); await api.cancelClaudeSignIn(result.signInId); return; }
      session.current = result.signInId;
      if (tab && !tab.closed) { tab.opener = null; tab.location.href = result.url; }
      else window.open(result.url, "_blank", "noopener");
      setStage("code");
    } catch (failure) {
      tab?.close();
      if (mounted.current) { setError(errorMessage(failure)); setStage("error"); }
    } finally { pending.current = false; }
  }

  async function finish(value: string) {
    if (pending.current || !session.current) return;
    if (!ClaudeSignInCode.safeParse({ code: value }).success) { setError("Paste the complete code from the Claude page"); return; }
    pending.current = true;
    setCode(""); setError(null); setStage("finishing");
    try {
      const result = await api.submitClaudeSignIn(session.current, value);
      session.current = null;
      if (mounted.current) { setStatus(result); setStage("success"); }
      await client.invalidateQueries({ queryKey: ["agent", agent.id] });
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (failure) {
      if (mounted.current) { setError(errorMessage(failure)); setStage("error"); }
    } finally { pending.current = false; }
  }

  if (stage === "success" && status) return <p className="notice info" role="status">Signed in as {claudeAccount(status.email, status.subscriptionType)}</p>;
  return <section className="claude-sign-in" aria-label="Sign in to Claude">
    <h2>Sign in to Claude</h2>
    <p>This agent works on your Claude plan. Sign in once; the sign-in stays on the agent's computer.</p>
    {stage === "ready" && <button type="button" className="pill dark" onClick={() => { void start(openConnectTab()); }}>Open Claude sign-in</button>}
    {stage === "starting" && <p role="status">{agent.computer.state === "running" ? "Opening Claude sign-in…" : "Starting the agent's computer…"}</p>}
    {(stage === "code" || stage === "finishing") && <form onSubmit={event => { event.preventDefault(); void finish(code.trim()); }}>
      <label>Paste the code from the Claude page
        <input type="text" autoComplete="off" spellCheck={false} value={code} disabled={stage === "finishing"}
          onChange={event => setCode(event.target.value)}
          onPaste={event => {
            const value = event.clipboardData.getData("text").trim();
            if (ClaudeSignInCode.safeParse({ code: value }).success) { event.preventDefault(); void finish(value); }
          }} />
      </label>
      <button className="pill dark" disabled={stage === "finishing" || !code.trim()}>{stage === "finishing" ? "Finishing sign-in…" : "Finish sign-in"}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {stage === "error" && <button type="button" className="pill" onClick={() => { void start(openConnectTab()); }}>Start again</button>}
    <small>Or sign in from the terminal in Computer.</small>
  </section>;
}
