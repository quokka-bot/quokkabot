import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, encodeTerminalFrame, parseTerminalFrame, terminalUrl } from "./api.js";
import { ErrorLine } from "./ui.js";
import "@xterm/xterm/css/xterm.css";

export default function TerminalSession({ agentId }: { agentId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState("Connecting");
  const client = useQueryClient();
  useEffect(() => {
    if (!container.current) return;
    let ended = false;
    let alive = true;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: "ui-monospace, monospace", theme: { background: "#131918", foreground: "#e6eeea" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    const socket = new WebSocket(terminalUrl(agentId));
    const resize = () => {
      const dimensions = fit.proposeDimensions();
      if (!dimensions) return;
      terminal.resize(Math.min(500, Math.max(10, dimensions.cols)), Math.min(200, Math.max(5, dimensions.rows)));
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeTerminalFrame({ t: "resize", cols: terminal.cols, rows: terminal.rows }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData(data => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(encodeTerminalFrame({ t: "in", d: data })); } catch (failure) { setError(failure); }
    });
    socket.onopen = () => { setStatus("Connected"); resize(); terminal.focus(); };
    socket.onmessage = message => {
      try {
        if (typeof message.data !== "string") throw new Error("Terminal frame: expected a JSON text frame");
        const frame = parseTerminalFrame(message.data);
        if (frame.t === "out") terminal.write(frame.d);
        else {
          ended = true;
          setStatus(`Exited${frame.code === null ? "" : ` · code ${frame.code}`}`);
          socket.close();
          void client.invalidateQueries();
        }
      } catch (failure) { setError(failure); socket.close(); }
    };
    socket.onerror = () => { setError(new Error("Terminal connection failed. Close it and check your passkey again.")); };
    socket.onclose = () => {
      if (!ended) {
        setStatus("Disconnected");
        void api.me().catch(failure => { if (alive) setError(failure); });
      }
      void client.invalidateQueries();
    };
    resize();
    return () => {
      alive = false;
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      socket.close(); observer.disconnect(); input.dispose(); terminal.dispose();
      void client.invalidateQueries();
    };
  }, [agentId, client]);
  return <div className="terminal-panel" data-hold-reload=""><p className="meta" role="status">{status}</p><ErrorLine error={error} /><div ref={container} className="terminal-container" aria-label="Owner sign-in terminal" /></div>;
}
