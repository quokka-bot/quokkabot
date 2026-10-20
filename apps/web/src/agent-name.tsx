import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { agentNameEdit, withAgent } from "@quokkabot/client";
import type { AgentsResponse, AgentSummary } from "@quokkabot/shared";
import { api, errorMessage } from "./api.js";
import { useAction } from "./ui.js";

// Writes the server's reply into the cached agent and agents list, so every place that shows the agent shows the change
// before the next poll. A poll sent before the save would otherwise land after this write with the old values.
export async function storeAgent(client: QueryClient, updated: AgentSummary): Promise<void> {
  await Promise.all([client.cancelQueries({ queryKey: ["agent", updated.id] }), client.cancelQueries({ queryKey: ["agents"], exact: true })]);
  client.setQueryData(["agent", updated.id], updated);
  client.setQueryData<AgentsResponse>(["agents"], list => withAgent(list, updated));
}

// The agent's name at the top of its details panel. Clicking it opens a field in its place: Enter or leaving the field
// saves, Escape keeps the old name.
export function AgentNameHeading({ agent }: { agent: AgentSummary }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // Refs, not state: Escape, Enter and the blur that follows them run before React renders again.
  const editing = useRef(false);
  const saving = useRef(false);
  const focusName = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const rename = useAction(async (name: string) => {
    await storeAgent(client, await api.rename(agent.id, name));
  });
  const open = draft !== null;
  useEffect(() => {
    if (open) { field.current?.focus(); field.current?.select(); }
    else if (focusName.current) { focusName.current = false; button.current?.focus(); }
  }, [open]);
  const start = () => { editing.current = true; rename.reset(); setInvalid(null); setStatus(""); setDraft(agent.name); };
  // Focus goes back to the name only when it is still in the field: a blur save leaves it where the owner clicked.
  const close = () => { editing.current = false; focusName.current = document.activeElement === field.current; setDraft(null); setInvalid(null); };
  const save = () => {
    if (!editing.current || saving.current || draft === null) return;
    const edit = agentNameEdit(draft, agent.name);
    if (edit.kind === "invalid") { setInvalid(edit.message); return; }
    if (edit.kind === "unchanged") { close(); return; }
    saving.current = true;
    setStatus("Saving the name…");
    rename.mutate(edit.name, {
      onSuccess: () => { saving.current = false; setStatus("Name saved."); close(); },
      onError: () => { saving.current = false; setStatus(""); },
    });
  };
  const message = invalid ?? (rename.error ? errorMessage(rename.error) : null);
  return <div className="agent-name">
    {draft === null
      ? <h2><button ref={button} type="button" className="agent-name-button" aria-label={`Rename ${agent.name}`} title="Rename" onClick={start}>
        <span>{agent.name}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      </button></h2>
      : <form className="agent-name-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <input ref={field} aria-label="Agent name" value={draft} readOnly={rename.isPending} autoComplete="off" spellCheck={false}
          aria-invalid={message ? true : undefined} aria-describedby={message ? errorId : undefined}
          onChange={event => { setDraft(event.target.value); setInvalid(null); if (rename.error) rename.reset(); }}
          onBlur={save}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (!saving.current) close(); } }} />
        {message && <p id={errorId} className="error" role="alert">{message}</p>}
      </form>}
    <span className="sr-only" role="status">{status}</span>
  </div>;
}
