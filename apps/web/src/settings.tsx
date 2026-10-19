import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Effort, type AgentSummary, type SessionView } from "@quokkabot/shared";
import { api } from "./api.js";
import { RemoveAgent } from "./agent-dialog.js";
import { dateLabel, ErrorLine, useAction, usePollInterval } from "./ui.js";

const CLIENT_LABELS: Record<SessionView["client"], string> = { browser: "Web app", desktop: "Mac app", phone: "iPhone app" };

export function Devices() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const devices = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const signOut = useAction(async (device: { id: string; current: boolean }) => {
    await api.signOutSession(device.id);
    if (device.current) { client.clear(); void navigate("/signin", { replace: true }); }
    else client.setQueryData<Awaited<ReturnType<typeof api.sessions>>>(["sessions"], data => data ? { sessions: data.sessions.filter(session => session.id !== device.id) } : undefined);
  });
  return <section className="card" aria-label="Signed-in devices">
    <h2>Signed-in devices</h2><ErrorLine error={devices.error} />
    {devices.isPending && <p role="status">Loading devices…</p>}
    <ul className="device-list">{devices.data?.sessions.map(device => <li key={device.id} className="domain-row"><div>
      <strong>{device.deviceName}</strong>{device.current && <span className="badge">This device</span>}
      <p className="meta">{CLIENT_LABELS[device.client]} · Last seen: {device.lastSeenAt ? dateLabel(device.lastSeenAt) : "Never"}</p>
    </div><button disabled={signOut.isPending} onClick={() => signOut.mutate(device)}>Sign out {device.deviceName}</button></li>)}</ul>
    {devices.data?.sessions.length === 0 && <p>No signed-in devices.</p>}
    <ErrorLine error={signOut.error} />
  </section>;
}

export function DesktopSettings() {
  const bridge = window.quokkabotDesktop;
  if (!bridge) throw new Error("Desktop settings require the desktop bridge");
  const client = useQueryClient();
  const interval = usePollInterval();
  const settings = useQuery({ queryKey: ["desktop-settings"], queryFn: () => bridge.getSettings() });
  const update = useQuery({ queryKey: ["desktop-update"], queryFn: () => bridge.getUpdateStatus(), refetchInterval: interval });
  const save = useAction(async (patch: Parameters<typeof bridge.setSettings>[0]) => {
    const next = await bridge.setSettings(patch);
    client.setQueryData(["desktop-settings"], next);
  });
  const downloads = useAction(() => bridge.showDownloads());
  const changeServer = useAction(() => bridge.changeServer());
  const restart = useAction(() => bridge.installUpdate());
  return <section className="card" aria-label="Desktop settings">
    <h2>Desktop app</h2><p>App version: {bridge.appVersion}</p><ErrorLine error={settings.error} />
    {settings.isPending && <p role="status">Loading desktop settings…</p>}
    {settings.data && <>
      <label className="switch"><input type="checkbox" checked={settings.data.launchAtLogin} disabled={save.isPending} onChange={event => save.mutate({ launchAtLogin: event.target.checked })} />Launch at login</label>
      <label className="switch"><input type="checkbox" checked={settings.data.notifications} disabled={save.isPending} onChange={event => save.mutate({ notifications: event.target.checked })} />Notifications</label>
      <label className="switch"><input type="checkbox" checked={settings.data.notificationDetails} disabled={save.isPending} onChange={event => save.mutate({ notificationDetails: event.target.checked })} />Show details in notifications</label>
    </>}
    <ErrorLine error={save.error} />
    <div className="actions wrap"><button disabled={downloads.isPending} onClick={() => downloads.mutate()}>Show downloads folder</button><button disabled={changeServer.isPending} onClick={() => changeServer.mutate()}>Change server</button></div>
    <ErrorLine error={downloads.error} /><ErrorLine error={changeServer.error} /><ErrorLine error={update.error} />
    {update.isPending && <p role="status">Loading update status…</p>}
    {update.data && <div className="update-status" role="status"><p>Update status: {update.data.state}{update.data.version && ` (${update.data.version})`}</p>{update.data.message && <p>{update.data.message}</p>}
      {update.data.state === "ready" && <button className="primary" disabled={restart.isPending} onClick={() => restart.mutate()}>Restart to update</button>}
    </div>}<ErrorLine error={restart.error} />
  </section>;
}

export function OwnerSettings() {
  return <><Devices />{window.quokkabotDesktop && <DesktopSettings />}</>;
}

export function Settings({ agent }: { agent: AgentSummary }) {
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState(agent.effort);
  const save = useAction(() => api.settings(agent.id, model.trim(), effort, name.trim()));
  return <>
    <h2>Settings</h2><form className="card settings-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <label>Name<input value={name} onChange={event => setName(event.target.value)} required maxLength={40} /></label>
      <label>Model<input value={model} onChange={event => setModel(event.target.value)} autoCapitalize="none" autoCorrect="off" required maxLength={81} /></label><p className="meta">Current default: {agent.model}</p>
      <label>Effort<select value={effort} onChange={event => setEffort(Effort.parse(event.target.value))}>{Effort.options.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button className="primary" disabled={save.isPending}>Save settings</button><ErrorLine error={save.error} />{save.isSuccess && <p role="status">Settings saved.</p>}
    </form>
    <OwnerSettings />
    <RemoveAgent agent={agent} />
  </>;
}
