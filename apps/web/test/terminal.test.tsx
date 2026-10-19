import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TerminalSession from "../src/terminal-session.js";
import { agentId } from "./fixtures.js";

const harness = vi.hoisted(() => ({
  write: vi.fn(), dispose: vi.fn(), focus: vi.fn(), resize: vi.fn(),
  input: null as ((data: string) => void) | null,
  resized: null as (() => void) | null,
  dimensions: { cols: 80, rows: 24 },
  inputDispose: vi.fn(), observerDisconnect: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} focus = harness.focus; write = harness.write; dispose = harness.dispose;
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; harness.resize(cols, rows); }
  onData(callback: (data: string) => void) { harness.input = callback; return { dispose: harness.inputDispose }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions() { return harness.dimensions; } } }));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
}

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  MockWebSocket.instances = [];
  harness.dimensions = { cols: 80, rows: 24 };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { harness.resized = callback; } observe() {} disconnect = harness.observerDisconnect; });
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

it("uses WSS, sends protocol input and resize frames, renders output and cleans up", async () => {
  const rendered = render(<QueryClientProvider client={client}><TerminalSession agentId={agentId} /></QueryClientProvider>);
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error("Terminal socket was not opened");
  // jsdom serves the app from http://localhost, the development case, so the socket is plain ws there; production is
  // https and gets wss (covered in api.test.ts).
  expect(socket.url).toMatch(new RegExp(`^ws://localhost(:[0-9]+)?/api/agents/${agentId}/terminal$`));
  act(() => socket.open());
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ t: "resize", cols: 80, rows: 24 }));
  act(() => harness.input?.("claude\r"));
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ t: "in", d: "claude\r" }));
  act(() => { harness.dimensions = { cols: 56, rows: 18 }; harness.resized?.(); });
  expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ t: "resize", cols: 56, rows: 18 }));
  act(() => socket.receive({ t: "out", d: "Sign in with your account" }));
  expect(harness.write).toHaveBeenCalledWith("Sign in with your account");
  act(() => socket.receive({ t: "exit", code: 0 }));
  expect(screen.getByRole("status").textContent).toBe("Exited · code 0");
  rendered.unmount();
  expect(socket.close).toHaveBeenCalled();
  expect(harness.observerDisconnect).toHaveBeenCalled();
  expect(harness.inputDispose).toHaveBeenCalled();
  expect(harness.dispose).toHaveBeenCalled();
});

it("rejects malformed terminal output without writing it", () => {
  render(<QueryClientProvider client={client}><TerminalSession agentId={agentId} /></QueryClientProvider>);
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error("No terminal socket");
  act(() => socket.receive({ t: "out", d: { secret: "invalid wire value" } }));
  expect(screen.getByRole("alert").textContent).toContain("Terminal frame: invalid response");
  expect(harness.write).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalled();
});
