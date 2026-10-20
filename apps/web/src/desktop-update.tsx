import { useQuery } from "@tanstack/react-query";
import type { QuokkaBotDesktopBridge } from "@quokkabot/shared";
import { ErrorLine, useAction, usePollInterval } from "./ui.js";

/** In the Mac app: a downloaded app update waits in the sidebar until the owner restarts into it. */
export function DesktopUpdateNotice() {
  const bridge = window.quokkabotDesktop;
  return bridge ? <ReadyUpdate bridge={bridge} /> : null;
}

function ReadyUpdate({ bridge }: { bridge: QuokkaBotDesktopBridge }) {
  const interval = usePollInterval();
  // The same query as the desktop settings card, so both show one status.
  const update = useQuery({ queryKey: ["desktop-update"], queryFn: () => bridge.getUpdateStatus(), refetchInterval: interval });
  const restart = useAction(() => bridge.installUpdate());
  if (update.data?.state !== "ready") return null;
  return <div className="desktop-update" role="status" aria-label="App update">
    <span>{update.data.version ? `Quokka Bot ${update.data.version} is ready.` : "A Quokka Bot update is ready."}</span>
    <button type="button" className="primary" disabled={restart.isPending} onClick={() => restart.mutate()}>Restart to update</button>
    <ErrorLine error={restart.error} />
  </div>;
}
