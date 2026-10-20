import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";
import { DesktopLinkDecideRequest } from "@quokkabot/shared";
import { api } from "./api.js";
import { ErrorLine, useAction } from "./ui.js";
import { ProductMark } from "./avatar.js";

// The code waiting for approval, kept across a sign-in; Settings also puts a phone's code here before opening /link.
export const LINK_CODE_KEY = "quokkabot:desktop-link-code";

export function DesktopLink() {
  const [code] = useState(() => window.location.hash.slice(1) || sessionStorage.getItem(LINK_CODE_KEY));
  const [prepared, setPrepared] = useState(false);
  const [done, setDone] = useState<"approved" | "refused" | null>(null);
  const valid = DesktopLinkDecideRequest.safeParse({ userCode: code }).success;
  useEffect(() => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    if (valid && code) sessionStorage.setItem(LINK_CODE_KEY, code);
    else sessionStorage.removeItem(LINK_CODE_KEY);
    setPrepared(true);
  }, [code, valid]);
  // Capture and remove the fragment before any request, including the sign-in check.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: prepared && valid });
  const pending = useQuery({ queryKey: ["desktop-link", code], queryFn: () => {
    if (!code) throw new Error("Desktop link code is missing");
    return api.desktopLink(code);
  }, enabled: prepared && valid && !!me.data && !done });
  // Unknown until the request loads. Kept after approval, when the pending query stops, so the done line still names
  // the right app.
  const [app, setApp] = useState<"desktop" | "phone" | null>(null);
  useEffect(() => { if (pending.data) setApp(pending.data.client); }, [pending.data]);
  const appName = app === "phone" ? "iPhone app" : app === "desktop" ? "desktop app" : "app";
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
    sessionStorage.removeItem(LINK_CODE_KEY);
  });
  return <div className="auth-card">
    <ProductMark size={64} />
    <h1>{app === null ? "Connect an app" : `Connect the ${appName}`}</h1>
    {done ? <p role="status">{done === "approved" ? `Approved. Return to the ${appName}.` : "Refused."}</p> : !valid ? <ErrorLine error={new Error("This code is missing or invalid. Start again in the app.")} /> : <>
      <ErrorLine error={me.error} /><ErrorLine error={pending.error} />
      {!pending.data && !me.error && !pending.error && <p role="status">Checking the request…</p>}
      {pending.data && <>
        <p><strong>{pending.data.deviceName}</strong> wants to {pending.data.kind === "signin" ? "sign in" : "confirm an action"}.</p>
        <p className="link-code">{code}</p><p>Only approve if the {appName} shows the same code</p>
        <button className="pill dark wide" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>Approve</button>
        <button className="pill wide" disabled={decide.isPending} onClick={() => decide.mutate("refuse")}>Refuse</button>
        <ErrorLine error={decide.error} />
      </>}
    </>}
  </div>;
}
