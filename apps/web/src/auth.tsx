import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api.js";
import { ErrorLine, useAction } from "./ui.js";
import { useDesktopFlow } from "./desktop.js";
import { AgentAvatar } from "./avatar.js";

export async function freshPasskey(): Promise<void> {
  const optionsJSON = await api.authOptions(true);
  const response = await startAuthentication({ optionsJSON });
  await api.freshVerify(response);
}

export function useFreshCheck() {
  const flow = useDesktopFlow();
  return { check: () => window.quokkabotDesktop ? flow.run("fresh") : freshPasskey(), prompt: flow.prompt };
}

export function SignIn() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const desktop = window.quokkabotDesktop;
  const flow = useDesktopFlow();
  const signIn = useAction(async () => {
    if (desktop) await flow.run("signin");
    else {
      const optionsJSON = await api.authOptions();
      const response = await startAuthentication({ optionsJSON });
      await api.authVerify(response);
    }
    // Only the browser's link approval is a supported return destination.
    void navigate(!desktop && params.get("returnTo") === "/link" ? "/link" : "/", { replace: true });
  });
  let buttonText = desktop ? "Sign in with your browser" : "Sign in with passkey";
  if (signIn.isPending) buttonText = desktop ? "Waiting for your browser…" : "Checking passkey…";
  else if (desktop && signIn.error) buttonText = "Try again";
  return <div className="auth-card">
    <AgentAvatar index={0} size={64} />
    <h1>Sign in to Quokka Bot</h1>
    <p className="auth-note">{desktop ? "Approve sign-in in your browser to open your agents." : "Use your passkey to open your agents."}</p>
    {flow.prompt}
    <button className="pill dark wide" disabled={signIn.isPending} onClick={() => signIn.mutate()}>{buttonText}</button>
    <ErrorLine error={signIn.error} />
  </div>;
}

export function Setup() {
  const navigate = useNavigate();
  // Capture once, then remove the ticket before fetching or navigating. It is only sent in POST bodies.
  const [ticket] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);
  const setup = useAction(async () => {
    const optionsJSON = await api.setupOptions(ticket);
    const response = await startRegistration({ optionsJSON });
    await api.setupVerify(ticket, response);
    void navigate("/", { replace: true });
  });
  return <div className="auth-card">
    <AgentAvatar index={0} size={64} />
    <h1>Make this Quokka Bot yours</h1>
    <p className="auth-note">Create a passkey to sign in and control your agents.</p>
    {!ticket ? <ErrorLine error={new Error("Setup ticket is missing. Open the link printed by the installer.")} /> : <button className="pill dark wide" disabled={setup.isPending} onClick={() => setup.mutate()}>{setup.isPending ? "Creating passkey…" : "Create passkey"}</button>}
    <ErrorLine error={setup.error} />
  </div>;
}
