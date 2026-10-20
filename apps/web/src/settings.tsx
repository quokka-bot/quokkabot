import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { agentLook } from "@quokkabot/client";
import { DesktopLinkDecideRequest, Effort, type AgentLook, type AgentSummary, type SessionView } from "@quokkabot/shared";
import { encode } from "uqr";
import { api } from "./api.js";
import { RemoveAgent } from "./agent-dialog.js";
import { storeAgent } from "./agent-name.js";
import { AiConsentSetting } from "./ai-consent.js";
import { LookPicker } from "./avatar.js";
import { ClaudeSetting } from "./claude-sign-in.js";
import { LINK_CODE_KEY } from "./link.js";
import { OwnerNameSetting } from "./owner.js";
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

// The iPhone app signs in with a link the owner approves here: it scans this server's address from the QR code (or
// the owner types it), then shows a code. The QR code holds only the address, so showing it grants nothing.
export function ConnectPhone() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const link = `quokkabot://connect?server=${encodeURIComponent(window.location.origin)}`;
  const qr = encode(link, { border: 2 });
  const userCode = code.trim().toUpperCase();
  const valid = DesktopLinkDecideRequest.safeParse({ userCode }).success;
  return <section className="card" aria-label="Connect a phone">
    <h2>Connect a phone</h2>
    <p>In the Quokka Bot iPhone app, tap Connect to your server and scan this code, or type {window.location.origin}.</p>
    <svg className="phone-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR code for ${window.location.origin}`} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      {qr.data.flatMap((row, y) => row.map((dark, x) => dark ? <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null))}
    </svg>
    <form className="actions wrap" onSubmit={event => {
      event.preventDefault();
      if (!valid) return;
      sessionStorage.setItem(LINK_CODE_KEY, userCode);
      void navigate("/link");
    }}>
      <label>Code shown on the phone <input value={code} onChange={event => setCode(event.target.value)} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" disabled={!valid}>Approve the phone</button>
    </form>
  </section>;
}

export function OwnerSettings() {
  return <><OwnerNameSetting /><ClaudeSetting /><Devices /><ConnectPhone />{window.quokkabotDesktop && <DesktopSettings />}</>;
}

export function Settings({ agent }: { agent: AgentSummary }) {
  // Null until the owner types here: the field shows a rename made in the details panel, and Save sends a name only
  // when the owner typed one, then follows the agent's name again.
  const [typedName, setName] = useState<string | null>(null);
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState(agent.effort);
  // Null until the owner picks here: the picker shows the agent's current look, and Save sends a look only when the
  // owner picked one, then follows the agent's look again.
  const [pickedLook, setPickedLook] = useState<AgentLook | null>(null);
  const client = useQueryClient();
  const save = useAction(async () => {
    const sent = typedName?.trim();
    const look = pickedLook ?? undefined;
    await storeAgent(client, await api.settings(agent.id, model.trim(), effort, sent, look));
    setName(current => current?.trim() === sent ? null : current);
    setPickedLook(current => current === look ? null : current);
  });
  return <>
    <h2>Settings</h2><form className="card settings-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <label>Name<input value={typedName ?? agent.name} onChange={event => setName(event.target.value)} required maxLength={40} /></label>
      <LookPicker look={pickedLook ?? agentLook(agent)} onChange={setPickedLook} />
      <label>Model<input value={model} onChange={event => setModel(event.target.value)} autoCapitalize="none" autoCorrect="off" required maxLength={81} /></label><p className="meta">Current default: {agent.model}</p>
      <label>Effort<select value={effort} onChange={event => setEffort(Effort.parse(event.target.value))}>{Effort.options.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button className="primary" disabled={save.isPending}>Save settings</button><ErrorLine error={save.error} />{save.isSuccess && <p role="status">Settings saved.</p>}
    </form>
    <AiConsentSetting agent={agent} />
    <OwnerSettings />
    <RemoveAgent agent={agent} />
  </>;
}
