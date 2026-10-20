import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { AgentSummary, AgentsResponse } from "@quokkabot/shared";
import { api } from "./api.js";
import { ErrorLine } from "./ui.js";

export function agentCapacityMessage(total: number): string {
  return `This server has room for ${total} agents. Set QUOKKABOT_AGENTS higher on the server and run install.sh again to add more.`;
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => dialog?.close();
  }, []);
  return createPortal(<dialog ref={ref} className="agent-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>, document.body);
}

export function NewAgentForm({ data, onClose }: { data: AgentsResponse; onClose?: () => void }) {
  const used = new Set(data.agents.map(agent => agent.index));
  let index = 1;
  while (used.has(index)) index += 1;
  const [name, setName] = useState(`Agent ${index}`);
  const client = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({ mutationFn: () => api.createAgent(name.trim()), retry: false, onSuccess: async agent => {
    // Slot ids are reused. Clear data from its previous occupant before navigating to the new chat.
    await client.cancelQueries({ predicate: query => query.queryKey.includes(agent.id) });
    client.removeQueries({ predicate: query => query.queryKey.includes(agent.id) });
    client.setQueryData(["agent", agent.id], agent);
    client.setQueryData<AgentsResponse>(["agents"], old => {
      if (!old) return undefined;
      const agents = [...old.agents.filter(item => item.id !== agent.id), agent].sort((a, b) => a.index - b.index);
      return { agents, capacity: { used: agents.length, total: old.capacity.total } };
    });
    void client.invalidateQueries({ queryKey: ["agents"] });
    void client.invalidateQueries({ queryKey: ["inbox"] });
    onClose?.();
    await navigate(`/agents/${agent.id}`);
  } });
  if (data.capacity.used >= data.capacity.total) return <>
    <p>{agentCapacityMessage(data.capacity.total)}</p>
    {onClose && <button type="button" onClick={onClose}>Cancel</button>}
  </>;
  return <form className="settings-form" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
    <label>Name<input autoFocus value={name} onChange={event => setName(event.target.value)} required minLength={1} maxLength={40} /></label>
    <ErrorLine error={create.error} />
    <div className="actions"><button className="primary" disabled={create.isPending || !name.trim()}>Create</button>
      {onClose && <button type="button" disabled={create.isPending} onClick={onClose}>Cancel</button>}
    </div>
  </form>;
}

export function NewAgentDialog({ data, onClose }: { data: AgentsResponse; onClose: () => void }) {
  return <Dialog title="New agent" onClose={onClose}><NewAgentForm data={data} onClose={onClose} /></Dialog>;
}

export function RemoveAgent({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({ mutationFn: () => api.removeAgent(agent.id), retry: false, onSuccess: async () => {
    await client.cancelQueries();
    // Tasks are keyed by task id, while files and settings use the agent id. Drop both when a slot is freed.
    client.removeQueries({ predicate: query => query.queryKey[0] !== "agents" && query.queryKey[0] !== "me" });
    const old = client.getQueryData<AgentsResponse>(["agents"]);
    const remaining = old?.agents.filter(item => item.id !== agent.id) ?? [];
    if (old) client.setQueryData<AgentsResponse>(["agents"], { agents: remaining, capacity: { used: remaining.length, total: old.capacity.total } });
    const next = remaining.find(item => item.index > agent.index) ?? remaining[0];
    setOpen(false);
    await navigate(next ? `/agents/${next.id}` : "/", { replace: true });
    void client.invalidateQueries({ queryKey: ["agents"] });
  } });
  return <section className="card remove-agent">
    {agent.removing && <p role="status">Removal is in progress. Retry Remove agent to finish.</p>}
    <button type="button" className="danger" onClick={() => setOpen(true)}>Remove agent</button>
    {open && <Dialog title={`Remove ${agent.name}?`} onClose={() => { if (!remove.isPending) setOpen(false); }}>
      <p>Its chats, files, saved logins and connected apps are deleted. This cannot be undone.</p>
      <ErrorLine error={remove.error} />
      <div className="actions"><button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>
        <button type="button" disabled={remove.isPending} onClick={() => setOpen(false)}>Cancel</button></div>
    </Dialog>}
  </section>;
}
