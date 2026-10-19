import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface CdpConnection {
  readonly connected: boolean;
  connect(): Promise<void>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: "event", listener: (method: string, params: unknown, sessionId?: string) => void): this;
  on(event: "disconnect", listener: () => void): this;
  close(): void;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class BrowserCdp extends EventEmitter implements CdpConnection {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  constructor(private readonly discoveryUrl = "http://127.0.0.1:9222/json/version", private readonly timeoutMs = 5000) { super(); }
  async connect(): Promise<void> {
    if (this.connected) return;
    const discovery = new URL(this.discoveryUrl);
    if (discovery.hostname !== "127.0.0.1" || discovery.protocol !== "http:") throw new Error("CDP discovery must be loopback HTTP");
    const response = await fetch(discovery, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    if (!response.ok) throw new Error("CDP discovery failed");
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("CDP discovery omitted its WebSocket URL");
    const address = new URL(body.webSocketDebuggerUrl);
    if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1" || address.port !== discovery.port ||
        address.username || address.password || !address.pathname.startsWith("/devtools/browser/")) {
      throw new Error("CDP returned an unsafe WebSocket URL");
    }
    const socket = new WebSocket(address, { handshakeTimeout: this.timeoutMs, maxPayload: 16 * 1024 * 1024 });
    this.socket = socket;
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown; sessionId?: string };
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error !== undefined) pending.reject(new Error("CDP command failed"));
          else pending.resolve(message.result);
        } else if (typeof message.method === "string") this.emit("event", message.method, message.params, message.sessionId);
      } catch { socket.close(1002, "invalid CDP message"); }
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
      this.emit("disconnect");
    });
    // Keep an error handler after the handshake so a transport error cannot crash the service.
    socket.on("error", () => socket.close());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("CDP WebSocket connection failed")));
      socket.once("close", () => reject(new Error("CDP WebSocket closed during connect")));
    });
  }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.connected) throw new Error("CDP is disconnected");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("CDP send failed"));
      });
    });
  }
  close(): void { this.socket?.close(); }
}
