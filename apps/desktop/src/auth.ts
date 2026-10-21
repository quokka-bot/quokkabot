import { hostname } from "node:os";
import { setTimeout } from "node:timers/promises";
import { DesktopLinkPollResponse, DesktopLinkStartResponse, Me } from "@quokkabot/shared";
import type { DesktopFlowResult, DesktopFlowStarted } from "@quokkabot/shared";
import type { ServerClient } from "./server.js";
import { responseError } from "./server.js";

interface Flow {
  controller: AbortController;
  promise: Promise<DesktopFlowResult>;
  resolve: (result: DesktopFlowResult) => void;
  pollToken: string | null;
  result: DesktopFlowResult | null;
}

export function verificationUrl(value: string, origin: string, code: string): string {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.pathname !== "/link" || url.search || url.hash !== `#${code}`) {
    throw new Error("The server returned an invalid sign-in verification URL.");
  }
  return url.href;
}

export class DesktopAuth {
  private flow: Flow | null = null;
  constructor(
    private readonly server: ServerClient,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly signedIn: () => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly pollInterval = 2000,
  ) {}

  startSignIn(): Promise<DesktopFlowStarted> { return this.start("signin"); }
  startFreshCheck(): Promise<DesktopFlowStarted> { return this.start("fresh"); }

  private async start(kind: "signin" | "fresh"): Promise<DesktopFlowStarted> {
    if (this.flow?.result === null) throw new Error("A sign-in or re-check is already in progress.");
    let resolve!: (result: DesktopFlowResult) => void;
    const promise = new Promise<DesktopFlowResult>((done) => { resolve = done; });
    const flow: Flow = { controller: new AbortController(), promise, resolve, pollToken: null, result: null };
    this.flow = flow;
    try {
      const response = DesktopLinkStartResponse.parse(await this.server.json("/api/desktop-link/start", {
        method: "POST", body: JSON.stringify({ kind, deviceName: `Quokka Bot on ${hostname()}`.slice(0, 80) }), signal: flow.controller.signal,
      }));
      flow.controller.signal.throwIfAborted();
      const expires = Date.parse(response.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("The sign-in link has already expired.");
      flow.pollToken = response.pollToken;
      await this.openBrowser(verificationUrl(response.verifyUrl, this.server.origin, response.userCode));
      flow.controller.signal.throwIfAborted();
      void this.poll(flow, kind, expires);
      return { userCode: response.userCode, expiresAt: response.expiresAt };
    } catch (error) {
      this.finish(flow, flow.controller.signal.aborted ? "cancelled" : "error");
      throw error;
    }
  }

  waitForFlow(): Promise<DesktopFlowResult> {
    if (this.flow === null) throw new Error("No sign-in or re-check has been started.");
    return this.flow.promise;
  }

  cancelFlow(): void {
    const flow = this.flow;
    if (flow === null || flow.result !== null) return;
    flow.controller.abort();
    this.finish(flow, "cancelled");
  }

  private finish(flow: Flow, result: DesktopFlowResult): void {
    if (flow.result !== null) return;
    flow.pollToken = null;
    flow.result = result;
    flow.resolve(result);
  }

  private async poll(flow: Flow, kind: "signin" | "fresh", expires: number): Promise<void> {
    try {
      while (flow.result === null) {
        const remaining = expires - Date.now();
        if (remaining <= 0) { this.finish(flow, "expired"); return; }
        await setTimeout(Math.min(this.pollInterval, remaining), undefined, { signal: flow.controller.signal });
        if (remaining <= this.pollInterval || Date.now() >= expires) { this.finish(flow, "expired"); return; }
        if (flow.pollToken === null) return;
        const response = await this.server.sessionFetch("/api/desktop-link/poll", {
          method: "POST", body: JSON.stringify({ pollToken: flow.pollToken }), signal: flow.controller.signal,
        });
        if (![200, 202, 410].includes(response.status)) throw await responseError(response);
        const { state } = DesktopLinkPollResponse.parse(await response.json());
        if ((response.status === 200 && state !== "approved") || (response.status === 202 && state !== "pending") || (response.status === 410 && !["refused", "expired"].includes(state))) {
          throw new Error("The server returned an inconsistent sign-in poll response.");
        }
        flow.controller.signal.throwIfAborted();
        if (state === "pending") continue;
        if (state === "approved") {
          const me = Me.parse(await this.server.json("/api/me", { signal: flow.controller.signal }));
          if (kind === "fresh" && (me.freshUntil === null || Date.parse(me.freshUntil) <= Date.now() || !Number.isFinite(Date.parse(me.freshUntil)))) {
            throw new Error("The server did not confirm a fresh session.");
          }
          flow.controller.signal.throwIfAborted();
          this.finish(flow, "approved");
          if (kind === "signin") await this.signedIn();
          return;
        }
        this.finish(flow, state);
      }
    } catch (error) {
      if (!flow.controller.signal.aborted) this.report(error);
      this.finish(flow, flow.controller.signal.aborted ? "cancelled" : "error");
    }
  }
}
