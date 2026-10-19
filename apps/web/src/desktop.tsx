import { useEffect, useRef, useState } from "react";
import type { QuokkaBotDesktopBridge, DesktopFlowStarted } from "@quokkabot/shared";
import { ErrorLine, useAction } from "./ui.js";

declare global {
  interface Window { quokkabotDesktop?: QuokkaBotDesktopBridge; }
}

// The poll token and cookies belong to main. The renderer only holds the display code.
export function useDesktopFlow() {
  const [started, setStarted] = useState<DesktopFlowStarted | null>(null);
  const generation = useRef(0);
  const activeBridge = useRef<QuokkaBotDesktopBridge | null>(null);
  useEffect(() => () => {
    generation.current += 1;
    const bridge = activeBridge.current;
    if (bridge) void bridge.cancelFlow().catch(error => {
      console.error("Could not cancel browser confirmation during page cleanup", error);
    });
  }, []);
  async function run(kind: "signin" | "fresh"): Promise<void> {
    const bridge = window.quokkabotDesktop;
    if (!bridge) throw new Error("Desktop bridge is unavailable");
    const current = ++generation.current;
    activeBridge.current = bridge;
    try {
      const flow = kind === "signin" ? await bridge.startSignIn() : await bridge.startFreshCheck();
      if (generation.current !== current) throw new Error("Browser confirmation cancelled.");
      setStarted(flow);
      const result = await bridge.waitForFlow();
      if (generation.current !== current || result === "cancelled") throw new Error("Browser confirmation cancelled.");
      if (result === "refused") throw new Error("Browser confirmation refused.");
      if (result === "expired") throw new Error("Browser confirmation expired.");
      if (result !== "approved") throw new Error("Browser confirmation failed. Try again.");
    } finally {
      if (generation.current === current) { activeBridge.current = null; setStarted(null); }
    }
  }
  const cancel = useAction(async () => {
    const bridge = activeBridge.current;
    if (!bridge) throw new Error("No browser confirmation is active");
    await bridge.cancelFlow();
  });
  const prompt = started && <div className="desktop-flow" role="status">
    <p>Approve this code in your browser</p><p className="link-code">{started.userCode}</p>
    <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</button>
    <ErrorLine error={cancel.error} />
  </div>;
  return { run, prompt };
}
