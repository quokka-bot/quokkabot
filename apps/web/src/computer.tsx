import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentSummary, ComputerView } from "@quokkabot/shared";
import { api } from "./api.js";
import { useFreshCheck } from "./auth.js";
import { Elapsed, ErrorLine, Status, useAction } from "./ui.js";

const TerminalSession = lazy(() => import("./terminal-session.js"));

function LiveView({ agentId }: { agentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    // A ticket is single use. Never put it in the query cache or persist it across mounts.
    void api.viewTicket(agentId).then(ticket => { if (alive) setUrl(ticket.url); }).catch(failure => { if (alive) setError(failure); });
    return () => { alive = false; };
  }, [agentId]);
  return <div className="live-view">
    <ErrorLine error={error} />
    {!url && !error && <p role="status">Opening live view…</p>}
    {url && <iframe src={url} title="Agent computer live view" allow="fullscreen" referrerPolicy="no-referrer" />}
  </div>;
}

export function Computer({ agent }: { agent: AgentSummary }) {
  const client = useQueryClient();
  const fresh = useFreshCheck();
  const [viewerRevision, setViewerRevision] = useState(0);
  const updateComputer = (computer: ComputerView) => {
    client.setQueryData<AgentSummary>(["agent", agent.id], current => current ? { ...current, computer } : undefined);
    return computer;
  };
  const power = useAction(async (action: "start" | "stop") => updateComputer(await api.computer(agent.id, action)));
  const lease = useAction(async (action: "take" | "return") => {
    const nextLease = await api.takeover(agent.id, action);
    client.setQueryData<AgentSummary>(["agent", agent.id], current => current ? { ...current, computer: { ...current.computer, lease: nextLease } } : undefined);
    return nextLease;
  });
  const attended = useAction(async (open: boolean) => updateComputer(await api.attended(agent.id, open)));
  const kill = useAction(async () => updateComputer(await api.kill(agent.id)));
  const release = useAction(async () => { await fresh.check(); return updateComputer(await api.releaseKill(agent.id)); });
  let releaseLabel = "Release kill switch";
  if (release.isPending) releaseLabel = window.quokkabotDesktop ? "Waiting for your browser…" : "Checking passkey…";
  else if (window.quokkabotDesktop && release.error) releaseLabel = "Try again";
  const computer = agent.computer;
  const killed = computer.state === "killed";
  const holder = agent.computer.lease.holder;
  // A phone may fit the screen to itself while the owner has control; when control leaves the owner the desktop size
  // comes back, and the live view streams the size it had when it connected, so it reconnects.
  const ownerHeld = useRef(holder === "owner");
  useEffect(() => {
    if (ownerHeld.current && holder !== "owner") setViewerRevision(value => value + 1);
    ownerHeld.current = holder === "owner";
  }, [holder]);
  const leaseLabel = holder === "owner" ? "You have control" : holder === "agent" ? "Agent is driving" : "Paused";
  return <>
    <div className="section-heading"><h2>Computer</h2><Status value={agent.computer.state} /></div>
    <div className="computer-controls card" data-hold-reload={holder === "owner" ? "" : undefined}>
      <div className="section-heading"><strong aria-live="polite">{leaseLabel}</strong>
        <div className="actions wrap">
          {holder !== "owner" && <button disabled={lease.isPending || killed} onClick={() => lease.mutate("take")}>Take over</button>}
          {holder !== "agent" && <button disabled={lease.isPending || killed} onClick={() => lease.mutate("return")}>Hand back</button>}
        </div>
      </div>
      {agent.computer.lease.expiresAt && <p className="meta">Control lease expires {new Date(agent.computer.lease.expiresAt).toLocaleTimeString()}</p>}
      <ErrorLine error={lease.error} />
      <div className="actions wrap">
        <button disabled={power.isPending || killed || agent.computer.state !== "stopped"} onClick={() => power.mutate("start")}>Start computer</button>
        <button disabled={power.isPending || killed || agent.computer.state === "stopped"} onClick={() => power.mutate("stop")}>Stop computer</button>
        <button onClick={() => setViewerRevision(value => value + 1)} disabled={killed || agent.computer.state !== "running"}>Refresh view</button>
      </div>
      <ErrorLine error={power.error} />
      <label className="switch attended-switch"><input type="checkbox" checked={agent.computer.attendedOpen} disabled={attended.isPending || killed} onChange={event => attended.mutate(event.target.checked)} /><span>Attended session<span className="meta block">Government and bank sites reachable while this is on</span></span></label>
      <ErrorLine error={attended.error} />
    </div>
    <div className="kill-panel card">
      <div><strong>Stop this agent’s computer</strong><p className="muted">Closes network access and stops all three sandboxes.</p></div>
      <button className="danger" disabled={kill.isPending} onClick={() => kill.mutate()}>Stop everything</button>
      <ErrorLine error={kill.error} />
      {killed && <><p>Kill switch engaged.{computer.killedAt && <> <Elapsed since={computer.killedAt} /></>}</p>{fresh.prompt}<button disabled={release.isPending} onClick={() => release.mutate()}>{releaseLabel}</button><ErrorLine error={release.error} /></>}
    </div>
    {!killed && !kill.isPending && agent.computer.state === "running" ? <LiveView key={`${agent.id}:${viewerRevision}`} agentId={agent.id} /> : <p className="empty card">Live view opens when the computer is running.</p>}
    <details className="card"><summary>Sandbox status</summary><ul className="sandbox-list">{agent.computer.sandboxes.map(sandbox => <li key={sandbox.name}><strong>{sandbox.name}</strong> <Status value={sandbox.state} /><span className="meta">{sandbox.runtime}</span></li>)}</ul></details>
  </>;
}

export function Terminal({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false);
  const fresh = useFreshCheck();
  const unlock = useAction(async () => { await fresh.check(); setOpen(true); });
  let unlockLabel = window.quokkabotDesktop ? "Open terminal with browser confirmation" : "Open terminal with passkey";
  if (unlock.isPending) unlockLabel = window.quokkabotDesktop ? "Waiting for your browser…" : "Checking passkey…";
  else if (window.quokkabotDesktop && unlock.error) unlockLabel = "Try again";
  useEffect(() => {
    if (agent.activeTaskId !== null || agent.computer.state !== "running") setOpen(false);
  }, [agent.activeTaskId, agent.computer.state]);
  return <>
    <h2>Terminal</h2>
    <p>Sign Claude Code in with your own plan on this agent’s computer.</p>
    <p className="meta">Claude Code sign-in: <strong>{agent.cliSignedIn}</strong></p>
    {agent.activeTaskId && <p className="waiting">The terminal is available after the active task ends.</p>}
    {fresh.prompt}
    {!open ? <button className="primary" disabled={unlock.isPending || agent.activeTaskId !== null || agent.computer.state !== "running"} onClick={() => unlock.mutate()}>{unlockLabel}</button> : <><button onClick={() => setOpen(false)}>Close terminal</button><Suspense fallback={<p role="status">Loading terminal…</p>}>{agent.activeTaskId === null && agent.computer.state === "running" && <TerminalSession agentId={agent.id} />}</Suspense></>}
    <ErrorLine error={unlock.error} />
  </>;
}
