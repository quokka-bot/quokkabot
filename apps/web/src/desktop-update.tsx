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
  const ready = update.data?.state === "ready" ? update.data : null;
  // The status region stays mounted while empty, so a screen reader announces the notice when it appears.
  return <div role="status" aria-label="App update">
    {ready && <div className="desktop-update">
      <span>{ready.version ? `Quokka Bot ${ready.version} is ready.` : "A Quokka Bot update is ready."}</span>
      <button type="button" className="primary" disabled={restart.isPending} onClick={() => restart.mutate()}>Restart to update</button>
      <ErrorLine error={restart.error} />
    </div>}
  </div>;
}
