import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, NavLink, Outlet, useParams } from "react-router";
import type { AgentSummary } from "@quokkabot/shared";
import { api } from "./api.js";
import { Audit } from "./audit.js";
import { AgentAvatar } from "./avatar.js";
import { ConnectedApps, GmailIcon } from "./apps.js";
import { DesktopUpdateNotice } from "./desktop-update.js";
import { AgentChat } from "./chat.js";
import { ClaudeSignInCard, claudeAccount } from "./claude-sign-in.js";
import { Computer, Terminal } from "./computer.js";
import { Domains } from "./domains.js";
import { Files } from "./files.js";
import { Logins } from "./logins.js";
import { Settings } from "./settings.js";
import { NewAgentDialog, NewAgentForm } from "./agent-dialog.js";
import { AgentNameHeading } from "./agent-name.js";
import { OwnerAvatarContent } from "./owner.js";
import { ErrorLine, Status, stateLabel, useAction, usePollInterval } from "./ui.js";

// The window: agents on the left, the selected agent's chat (or one of its screens) in the middle, its details on the
// right.

function AgentRow({ agent }: { agent: AgentSummary }) {
  const interval = usePollInterval();
  const latest = useQuery({ queryKey: ["agent-tasks", agent.id], queryFn: () => api.tasks(agent.id), refetchInterval: interval });
  const task = latest.data?.tasks[0];
  const preview = agent.waitingOnOwner > 0 ? "Waiting for you" : task ? task.result?.summary ?? task.title : agent.cliSignedIn === "yes" ? "Ready for a task" : "Sign in to Claude";
  return <NavLink to={`/agents/${agent.id}`} className={({ isActive }) => `agent-row${isActive ? " selected" : ""}`}>
    <span className="agent-row-avatar"><AgentAvatar agent={agent} working={agent.activeTaskId !== null} />{agent.waitingOnOwner > 0 && <span className="badge-dot" aria-label={`${agent.waitingOnOwner} waiting`} />}</span>
    <span className="agent-row-text"><strong>{agent.name}{agent.activeTaskId !== null && <span className="sr-only">, working</span>}</strong><span className={agent.waitingOnOwner > 0 ? "waiting-preview" : ""}>{preview}</span></span>
  </NavLink>;
}

function Sidebar() {
  const interval = usePollInterval();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: interval });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { agentId } = useParams();
  const [filter, setFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = (agents.data?.agents ?? []).filter(agent => agent.name.toLowerCase().includes(filter.toLowerCase()));
  const appsFor = agentId ?? agents.data?.agents[0]?.id;
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button type="button" className="round-button" aria-label="Search agents" onClick={() => setSearching(value => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg></button>
      <button type="button" className="round-button" aria-label="New agent" title="New agent" disabled={!agents.data} onClick={() => setAdding(true)}>+</button>
    </div>
    {searching && <input className="sidebar-search" aria-label="Search agents" placeholder="Search" value={filter} autoFocus onChange={event => setFilter(event.target.value)} />}
    <nav className="agent-list" aria-label="Agents">
      <ErrorLine error={agents.error} />
      {list.map(agent => <AgentRow key={agent.id} agent={agent} />)}
      {agents.data?.agents.length === 0 && <p className="sidebar-empty">No agents on this server.</p>}
    </nav>
    <button type="button" className="new-agent" aria-label="New agent" disabled={!agents.data} onClick={() => setAdding(true)}>+ New agent</button>
    {adding && agents.data && <NewAgentDialog data={agents.data} onClose={() => setAdding(false)} />}
    <DesktopUpdateNotice />
    <div className="sidebar-bottom">
      <NavLink to="/settings" className="owner-avatar" aria-label="Settings" title="Settings"><OwnerAvatarContent name={me.data?.ownerName} /></NavLink>
      {appsFor ? <NavLink to={`/agents/${appsFor}/apps`} className="pill">Connect apps <GmailIcon /></NavLink> : <NavLink to="/settings" className="pill">Settings</NavLink>}
    </div>
  </aside>;
}

export function OwnerLayout() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  return <div className="window">
    <Sidebar />
    <main className="main">
      <ErrorLine error={me.error} />
      {me.data ? <Outlet /> : me.isPending ? <p className="notice info">Opening Quokka Bot…</p> : null}
    </main>
  </div>;
}

export function FirstAgent() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  if (agents.error) return <ErrorLine error={agents.error} />;
  const first = agents.data?.agents[0];
  if (agents.data && !first) return <div className="first-agent"><section className="card"><h1>New agent</h1><NewAgentForm data={agents.data} /></section></div>;
  return first ? <Navigate to={`/agents/${first.id}`} replace /> : null;
}

export function TaskRedirect() {
  const { taskId } = useParams();
  if (!taskId) throw new Error("Task route is missing taskId");
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  if (detail.error) return <ErrorLine error={detail.error} />;
  return detail.data ? <Navigate to={`/agents/${detail.data.task.agentId}?task=${taskId}`} replace /> : null;
}

const SECTIONS = { computer: "Computer", terminal: "Terminal", files: "Library", apps: "Connected apps", logins: "Logins", domains: "Allowed sites", audit: "Activity log", settings: "Agent settings" } as const;
type Section = keyof typeof SECTIONS;
const PANEL_KEY = "quokkabot:details-panel";

function Panel({ agent, onClose }: { agent: AgentSummary; onClose: () => void }) {
  const [tab, setTab] = useState<"details" | "library" | "computer">("details");
  const [signingIn, setSigningIn] = useState(false);
  const logins = useQuery({ queryKey: ["logins", agent.id], queryFn: () => api.logins(agent.id) });
  const connectors = useQuery({ queryKey: ["connectors", agent.id], queryFn: () => api.connectors(agent.id) });
  return <aside className="panel" aria-label={`${agent.name} details`}>
    <div className="panel-top"><button type="button" className="round-button" aria-label="Close details" onClick={onClose}>×</button></div>
    <div className="panel-head">
      <AgentAvatar agent={agent} size={76} working={agent.activeTaskId !== null} />
      <AgentNameHeading agent={agent} />
      <p>{agent.model} · {agent.effort}</p>
    </div>
    <div className="tabs" role="tablist">
      {(["details", "library", "computer"] as const).map(name => <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "tab selected" : "tab"} onClick={() => setTab(name)}>{name[0]?.toUpperCase()}{name.slice(1)}</button>)}
    </div>
    {tab === "details" && <div className="panel-body">
      <div className="panel-card">
        <div className="panel-line"><span>Computer</span><Status value={agent.computer.state} /></div>
        <div className="panel-line"><span>Claude Code</span>{agent.cliSignedIn === "yes" ? <span className="ok-text">{claudeAccount(agent.cliAccount, agent.cliPlan) || "Signed in"}</span> : <button type="button" className="link-button" onClick={() => setSigningIn(value => !value)}>Sign in</button>}</div>
      </div>
      {signingIn && agent.cliSignedIn !== "yes" && <ClaudeSignInCard key={agent.id} agent={agent} />}
      <p className="panel-label">Manage</p>
      <div className="panel-card links">
        <Link to={`/agents/${agent.id}/apps`}><span>Connected apps</span><span className="muted">{connectors.data ? connectors.data.connectors.length : ""}</span></Link>
        <Link to={`/agents/${agent.id}/logins`}><span>Logins</span><span className="muted">{logins.data ? logins.data.logins.length : ""}</span></Link>
        <Link to={`/agents/${agent.id}/domains`}><span>Allowed sites</span><span className="muted">›</span></Link>
        <Link to={`/agents/${agent.id}/audit`}><span>Activity log</span><span className="muted">›</span></Link>
        <Link to={`/agents/${agent.id}/settings`}><span>Agent settings</span><span className="muted">›</span></Link>
      </div>
    </div>}
    {tab === "library" && <div className="panel-body"><Files agentId={agent.id} computer={agent.computer.state} /></div>}
    {tab === "computer" && <div className="panel-body">
      <div className="panel-card">
        <div className="panel-line"><span>State</span><Status value={agent.computer.state} /></div>
        <div className="panel-line"><span>Browser</span><span>{agent.computer.lease.holder === "owner" ? "You have control" : agent.computer.lease.holder === "agent" ? "Agent in control" : stateLabel(agent.computer.lease.holder)}</span></div>
      </div>
      <div className="panel-actions">
        <Link className="pill dark" to={`/agents/${agent.id}/computer`}>Open computer</Link>
        <Link className="pill" to={`/agents/${agent.id}/terminal`}>Terminal</Link>
      </div>
    </div>}
  </aside>;
}

function SectionView({ agent, section }: { agent: AgentSummary; section: Section }) {
  switch (section) {
    case "computer": return <Computer key={agent.id} agent={agent} />;
    case "terminal": return <Terminal key={agent.id} agent={agent} />;
    case "files": return <Files key={agent.id} agentId={agent.id} computer={agent.computer.state} />;
    case "apps": return <ConnectedApps key={agent.id} agentId={agent.id} />;
    case "logins": return <Logins key={agent.id} agentId={agent.id} />;
    case "domains": return <Domains key={agent.id} agentId={agent.id} />;
    case "audit": return <Audit key={agent.id} agentId={agent.id} />;
    case "settings": return <Settings key={agent.id} agent={agent} />;
  }
}

export function AgentScreen() {
  const { agentId, section } = useParams();
  if (!agentId) throw new Error("Agent route is missing agentId");
  const interval = usePollInterval();
  const client = useQueryClient();
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.agent(agentId), refetchInterval: interval });
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== "closed");
  const togglePanel = useAction(async (open: boolean) => { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); setPanelOpen(open); await client.invalidateQueries({ queryKey: ["logins", agentId] }); });
  if (agent.error) return <ErrorLine error={agent.error} />;
  if (!agent.data) return <p className="notice info">Loading…</p>;
  if (section !== undefined && !(section in SECTIONS)) return <Navigate to={`/agents/${agentId}`} replace />;
  return <div className="agent-screen">
    <div className="center">
      <header className="center-top">
        {section ? <Link className="back-link" to={`/agents/${agentId}`}>‹ Chat</Link> : <span />}
        <span className="title-pill"><AgentAvatar agent={agent.data} size={22} working={agent.data.activeTaskId !== null} />{section ? `${agent.data.name} · ${SECTIONS[section as Section]}` : agent.data.name}</span>
        {panelOpen ? <span /> : <button type="button" className="round-button" aria-label="Show details" onClick={() => togglePanel.mutate(true)}>ⓘ</button>}
      </header>
      {agent.data.removing && <p className="notice info">Removal is in progress. <Link to={`/agents/${agentId}/settings`}>Retry Remove agent</Link> to finish.</p>}
      {section ? <div className="section-scroll"><div className="section-column"><SectionView agent={agent.data} section={section as Section} /></div></div> : <AgentChat key={agent.data.id} agent={agent.data} />}
    </div>
    {panelOpen && <Panel key={agent.data.id} agent={agent.data} onClose={() => togglePanel.mutate(false)} />}
  </div>;
}

export function GlobalSettings({ children }: { children: ReactNode }) {
  return <div className="agent-screen"><div className="center">
    <header className="center-top"><span /><span className="title-pill">Settings</span><span /></header>
    <div className="section-scroll"><div className="section-column">{children}</div></div>
  </div></div>;
}
