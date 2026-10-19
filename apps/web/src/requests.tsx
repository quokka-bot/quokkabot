import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { DomainRequestView, LoginView, OwnerRequest } from "@quokkabot/shared";
import { listSites, loginRequestOptions } from "@quokkabot/client";
import { api } from "./api.js";
import { GmailIcon, openConnectTab, startGmailIn, useConnectGmail } from "./apps.js";
import { LoginForm } from "./logins.js";
import { ErrorLine, useAction } from "./ui.js";

// Cards the agent puts in the chat when it needs the owner. Questions are answered in the composer; these cover a
// login, a browser takeover and a site the agent wants to reach.

export function RequestCard({ request, agentId }: { request: OwnerRequest; agentId: string }) {
  const [resolved, setResolved] = useState(false);
  if (resolved || request.answeredAt !== null || request.kind === "question") return null;
  if (request.kind === "login") return <LoginRequestCard request={request} agentId={agentId} onResolved={() => setResolved(true)} />;
  if (request.kind === "connect") return <ConnectCard request={request} agentId={agentId} />;
  return <TakeoverCard request={request} agentId={agentId} onResolved={() => setResolved(true)} />;
}

// The agent needs an app connected. The owner approves on the app's own page in the browser; the task continues by
// itself once the connection arrives, so this card only starts it.
function ConnectCard({ request, agentId }: { request: OwnerRequest; agentId: string }) {
  const connect = useConnectGmail(agentId);
  return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true"><GmailIcon /></span>
      <span className="action-text"><strong>Connect Gmail</strong><span>{connect.isSuccess ? "Finish on Google's page in your browser" : "Approve on Google's page, no password here"}</span></span>
      <button type="button" className="pill dark" disabled={connect.isPending} onClick={() => connect.mutate(openConnectTab())}>{connect.isSuccess ? "Open again" : "Connect"}</button>
    </div>
    <p className="plain action-reason">{request.text}</p>
    <ErrorLine error={connect.error} />
  </article>;
}

function TakeoverCard({ request, agentId, onResolved }: { request: OwnerRequest; agentId: string; onResolved: () => void }) {
  const navigate = useNavigate();
  const take = useAction(async () => {
    await api.takeover(agentId, "take");
    void navigate(`/agents/${agentId}/computer`);
  });
  const done = useAction(async () => { await api.takeoverDone(request.taskId, ""); onResolved(); });
  return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true">🖥</span>
      <span className="action-text"><strong>Take over the browser</strong><span>{request.whatToDo ?? request.text}</span></span>
      <button type="button" className="pill dark" disabled={take.isPending} onClick={() => take.mutate()}>Open</button>
    </div>
    <div className="action-card-foot">
      <button type="button" className="link-button" disabled={done.isPending} onClick={() => done.mutate()}>I'm done, continue</button>
    </div>
    <ErrorLine error={take.error ?? done.error} />
  </article>;
}

// The agent needs a login it does not have, or a saved one the site rejected (request.loginId names it). Saving the form
// answers the request on the server and the agent continues; "Sign in myself" turns it into a browser takeover.
function LoginRequestCard({ request, agentId, onResolved }: { request: OwnerRequest; agentId: string; onResolved: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const logins = useQuery({ queryKey: ["logins", agentId], queryFn: () => api.logins(agentId), enabled: request.loginId !== null });
  const existing = request.loginId === null ? undefined : logins.data?.logins.find((login) => login.id === request.loginId);
  const myself = useAction(async () => {
    await api.signInMyself(request.id);
    await api.takeover(agentId, "take");
    void navigate(`/agents/${agentId}/computer`);
  });
  const { title, otherSite, google } = loginRequestOptions(request, existing);
  const connectInstead = useAction(async (tab: Window | null) => {
    // Start the connection first; the agent is told only once Google's page is on its way.
    await startGmailIn(agentId, tab);
    await api.reply(request.taskId, "Use the Gmail connection instead of signing in to Google in the browser. I'm connecting Gmail now.");
    onResolved();
  });
  if (google) return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true"><GmailIcon /></span>
      <span className="action-text"><strong>Connect Gmail</strong><span>Approve on Google's page, no password here</span></span>
      <button type="button" className="pill dark" disabled={connectInstead.isPending} onClick={() => connectInstead.mutate(openConnectTab())}>Connect</button>
    </div>
    <p className="plain action-reason">{request.text}</p>
    <ErrorLine error={connectInstead.error} />
  </article>;
  if (otherSite && existing !== undefined && request.site !== null) {
    return <AllowLoginCard login={existing} site={request.site} onResolved={onResolved} signInMyself={() => myself.mutate()} signingIn={myself.isPending} signInError={myself.error} />;
  }
  return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true">🔑</span>
      <span className="action-text"><strong>{title}</strong><span>{request.loginId === null ? "Secure form" : `${request.site ?? "The site"} rejected it`}</span></span>
      {!open && <button type="button" className="pill dark" onClick={() => setOpen(true)}>Open</button>}
    </div>
    <p className="plain action-reason">{request.text}</p>
    {open && (request.loginId !== null
      ? existing
        ? <LoginForm agentId={agentId} login={existing} onSaved={onResolved} onCancel={() => setOpen(false)} />
        : logins.isPending ? <p role="status">Loading the saved login…</p> : <ErrorLine error={logins.error ?? new Error("The saved login was deleted. Add it again in Logins.")} />
      : request.site
        ? <LoginForm agentId={agentId} initialSite={request.site} initialName={request.loginName ?? request.site} onSaved={onResolved} onCancel={() => setOpen(false)} />
        : <ErrorLine error={new Error("Login request is missing its site")} />)}
    <div className="action-card-foot">
      <button type="button" className="link-button" disabled={myself.isPending} onClick={() => myself.mutate()}>Sign in myself instead</button>
    </div>
    <ErrorLine error={myself.error} />
  </article>;
}

function AllowLoginCard({ login, site, onResolved, signInMyself, signingIn, signInError }: {
  login: LoginView; site: string; onResolved: () => void; signInMyself: () => void; signingIn: boolean; signInError: Error | null;
}) {
  const allow = useAction(async () => {
    await api.updateLogin(login.id, { sites: [...login.sites, site] });
    onResolved();
  });
  return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true">🔑</span>
      <span className="action-text"><strong>Use the {login.name} login on {site}</strong><span>Saved for {listSites(login.sites)}</span></span>
      <button type="button" className="pill dark" disabled={allow.isPending} onClick={() => allow.mutate()}>Allow</button>
    </div>
    <div className="action-card-foot">
      <button type="button" className="link-button" disabled={signingIn} onClick={signInMyself}>Sign in myself instead</button>
    </div>
    <ErrorLine error={allow.error ?? signInError} />
  </article>;
}

export function DomainRequestCard({ request }: { request: DomainRequestView }) {
  const [attended, setAttended] = useState(false);
  const [resolved, setResolved] = useState(false);
  const decide = useAction(async (decision: "allow_task" | "allow_always" | "refuse") => {
    await api.decideDomain(request.id, decision, attended);
    setResolved(true);
  });
  if (resolved || request.decidedAt !== null) return null;
  return <article className="action-card">
    <div className="action-card-row">
      <span className="action-icon" aria-hidden="true">🌐</span>
      <span className="action-text"><strong>Allow {listSites(request.domains)}</strong><span>{request.reason}</span></span>
    </div>
    <label className="switch"><input type="checkbox" checked={attended} onChange={event => setAttended(event.target.checked)} />Only while I watch</label>
    <div className="actions wrap">
      <button type="button" className="pill dark" disabled={decide.isPending || request.taskId === null} onClick={() => decide.mutate("allow_task")}>Allow for this task</button>
      <button type="button" className="pill" disabled={decide.isPending} onClick={() => decide.mutate("allow_always")}>Always allow</button>
      <button type="button" className="pill" disabled={decide.isPending} onClick={() => decide.mutate("refuse")}>Refuse</button>
    </div>
    <ErrorLine error={decide.error} />
  </article>;
}
