import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";
import { DesktopLinkDecideRequest } from "@quokkabot/shared";
import { api } from "./api.js";
import { ErrorLine, useAction } from "./ui.js";
import { AgentAvatar } from "./avatar.js";

const CODE_KEY = "quokkabot:desktop-link-code";

export function DesktopLink() {
  const [code] = useState(() => window.location.hash.slice(1) || sessionStorage.getItem(CODE_KEY));
  const [prepared, setPrepared] = useState(false);
  const [done, setDone] = useState<"approved" | "refused" | null>(null);
  const valid = DesktopLinkDecideRequest.safeParse({ userCode: code }).success;
  useEffect(() => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    if (valid && code) sessionStorage.setItem(CODE_KEY, code);
    else sessionStorage.removeItem(CODE_KEY);
    setPrepared(true);
  }, [code, valid]);
  // Capture and remove the fragment before any request, including the sign-in check.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: prepared && valid });
  const pending = useQuery({ queryKey: ["desktop-link", code], queryFn: () => {
    if (!code) throw new Error("Desktop link code is missing");
    return api.desktopLink(code);
  }, enabled: prepared && valid && !!me.data && !done });
  const decide = useAction(async (decision: "approve" | "refuse") => {
    if (!code) throw new Error("Desktop link code is missing");
    if (decision === "approve") {
      const optionsJSON = await api.desktopLinkOptions(code);
      const response = await startAuthentication({ optionsJSON });
      await api.approveDesktopLink(code, response);
      setDone("approved");
    } else {
      await api.refuseDesktopLink(code);
      setDone("refused");
    }
    sessionStorage.removeItem(CODE_KEY);
  });
  return <div className="auth-card">
    <AgentAvatar index={0} size={64} />
    <h1>Connect the desktop app</h1>
    {done ? <p role="status">{done === "approved" ? "Approved. Return to the desktop app." : "Refused."}</p> : !valid ? <ErrorLine error={new Error("Desktop link code is missing or invalid. Start again in the desktop app.")} /> : <>
      <ErrorLine error={me.error} /><ErrorLine error={pending.error} />
      {!pending.data && !me.error && !pending.error && <p role="status">Checking desktop request…</p>}
      {pending.data && <>
        <p><strong>{pending.data.deviceName}</strong> wants to {pending.data.kind === "signin" ? "sign in" : "confirm an action"}.</p>
        <p className="link-code">{code}</p><p>Only approve if the desktop app shows the same code</p>
        <button className="pill dark wide" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>Approve</button>
        <button className="pill wide" disabled={decide.isPending} onClick={() => decide.mutate("refuse")}>Refuse</button>
        <ErrorLine error={decide.error} />
      </>}
    </>}
  </div>;
}
