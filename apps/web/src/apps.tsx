import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { ErrorLine, dateLabel, useAction } from "./ui.js";

// Google's consent page opens in the browser (the desktop app sends https links to the default browser). Google then
// sends the browser back to Quokka Bot, which stores the connection and lets a waiting task continue. In a browser the
// tab is opened during the click, before the server answers, so a slow answer cannot get it blocked as a popup.
export function openConnectTab(): Window | null {
  return window.quokkabotDesktop ? null : window.open("", "_blank");
}

export async function startGmailIn(agentId: string, tab: Window | null): Promise<void> {
  try {
    const { url } = await api.startGmail(agentId);
    if (tab && !tab.closed) { tab.opener = null; tab.location.href = url; }
    else window.open(url, "_blank", "noopener");
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export function useConnectGmail(agentId: string) {
  return useAction((tab: Window | null) => startGmailIn(agentId, tab));
}

export function GmailIcon() {
  return <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7c1.66 0 3-1.34 3-3V16.2z" />
    <path fill="#1e88e5" d="M3 16.2l3.61 1.71L13 23.7V40H6c-1.66 0-3-1.34-3-3V16.2z" />
    <path fill="#e53935" d="M35 11.2L24 19.45 13 11.2 12 17l1 6.7 11 8.25 11-8.25 1-6.7z" />
    <path fill="#c62828" d="M3 12.3v3.9l10 7.5V11.2L9.88 8.86C9.13 8.3 8.21 8 7.27 8 4.91 8 3 9.91 3 12.27z" />
    <path fill="#fbc02d" d="M45 12.3v3.9l-10 7.5V11.2l3.12-2.34C38.87 8.3 39.79 8 40.73 8 43.09 8 45 9.91 45 12.27z" />
  </svg>;
}

export function ConnectedApps({ agentId }: { agentId: string }) {
  const connectors = useQuery({ queryKey: ["connectors", agentId], queryFn: () => api.connectors(agentId), refetchInterval: 5000 });
  const connect = useConnectGmail(agentId);
  const remove = useAction((id: string) => api.removeConnector(id));
  const gmail = connectors.data?.connectors.filter(item => item.app === "gmail") ?? [];
  return <>
    <h2>Connected apps</h2>
    <p className="muted">The agent uses these through the app's own access, approved by you on its page. No passwords.</p>
    <ErrorLine error={connectors.error} />
    <div className="panel-card app-list">
      <div className="app-row">
        <span className="app-icon"><GmailIcon /></span>
        <span className="app-text"><strong>Gmail</strong><span>{gmail.length > 0 ? `Connected: ${gmail.map(item => item.account).join(", ")}` : "Read, search and draft email"}</span></span>
        {connectors.data && !connectors.data.available.gmail
          ? <span className="muted">Not set up on this server</span>
          : <button type="button" className="pill dark" disabled={connect.isPending || !connectors.data} onClick={() => connect.mutate(openConnectTab())}>{gmail.length > 0 ? "Switch account" : "Connect"}</button>}
      </div>
      {gmail.map(item => <div key={item.id} className="app-row sub">
        <span className="app-text"><strong>{item.account}</strong><span>Connected {dateLabel(item.connectedAt)}</span></span>
        <button type="button" className="pill" disabled={remove.isPending} onClick={() => { if (window.confirm(`Disconnect ${item.account}?`)) remove.mutate(item.id); }}>Disconnect</button>
      </div>)}
    </div>
    <ErrorLine error={connect.error ?? remove.error} />
  </>;
}
