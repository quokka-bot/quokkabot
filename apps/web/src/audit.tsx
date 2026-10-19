import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { dateLabel, ErrorLine, useAction } from "./ui.js";

export function Audit({ agentId }: { agentId: string }) {
  const audit = useInfiniteQuery({ queryKey: ["audit", agentId], initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.audit(agentId, pageParam),
    getNextPageParam: page => page.events.length && Math.min(...page.events.map(event => event.seq)) > 1 ? Math.min(...page.events.map(event => event.seq)) : undefined,
  });
  const [copied, setCopied] = useState(false);
  const head = audit.data?.pages[0]?.head;
  const copy = useAction(async () => {
    if (!head) throw new Error("Audit head is not loaded");
    await navigator.clipboard.writeText(JSON.stringify(head)); setCopied(true);
  });
  const verify = useAction(() => api.verifyAudit(agentId));
  const events = audit.data?.pages.flatMap(page => page.events).filter((event, index, all) => all.findIndex(other => other.seq === event.seq) === index).sort((a, b) => b.seq - a.seq);
  return <>
    <h2>Audit</h2><ErrorLine error={audit.error} />{audit.isPending && <p role="status">Loading audit…</p>}
    {head && <section className="card"><h3>Chain head · {head.seq}</h3><code className="hash">{head.hash}</code><p className="muted">Save this to detect later changes.</p><div className="actions wrap"><button disabled={copy.isPending} onClick={() => copy.mutate()}>{copied ? "Copy again" : "Copy head hash"}</button><button disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? "Verifying…" : "Verify chain"}</button></div><ErrorLine error={copy.error} /><ErrorLine error={verify.error} />{copied && <p role="status">Copied chain checkpoint.</p>}{verify.data && <p role="status" className={verify.data.ok ? "verified" : "error"}>{verify.data.ok ? `Chain verified: ${verify.data.count} events.` : `Chain failed at event ${verify.data.failedAtSeq}: ${verify.data.reason}`}</p>}</section>}
    <ol className="audit-list">{events?.map(event => <li key={event.seq} className="card"><div className="section-heading"><strong>{event.type}</strong><span className="badge">{event.actor}</span></div><p className="meta">#{event.seq} · {dateLabel(event.at)}</p><pre className="compact-json">{JSON.stringify(event.data)}</pre></li>)}</ol>
    {events?.length === 0 && <p className="muted">No audit events yet.</p>}{audit.hasNextPage && <button disabled={audit.isFetchingNextPage} onClick={() => { void audit.fetchNextPage(); }}>Load older events</button>}
  </>;
}
