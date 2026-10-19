import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { siteLabel, type BlockedHostView, type DomainRuleView } from "@quokkabot/shared";
import { api } from "./api.js";
import { DomainRequestCard } from "./requests.js";
import { dateLabel, ErrorLine, useAction, usePollInterval } from "./ui.js";

function DomainRule({ rule }: { rule: DomainRuleView }) {
  const remove = useAction(() => api.removeDomain(rule.id));
  return <li className="domain-row"><div><strong className="plain" title={rule.pattern}>{siteLabel(rule.pattern)}</strong><p className="meta">{rule.attended && <span className="badge">Attended only</span>} {rule.scope === "task" ? "For this task" : "Permanent"}</p></div><button disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button><ErrorLine error={remove.error} /></li>;
}
function BlockedHost({ agentId, host }: { agentId: string; host: BlockedHostView }) {
  const allow = useAction((attended: boolean) => api.addDomain(agentId, host.host, attended));
  return <li className="blocked-host"><strong className="plain">{host.host}</strong><p className="meta">{host.count} blocked · {dateLabel(host.lastAt)}</p><div className="actions wrap"><button disabled={allow.isPending} onClick={() => allow.mutate(false)}>Allow</button><button disabled={allow.isPending} onClick={() => allow.mutate(true)}>Allow, attended only</button></div><ErrorLine error={allow.error} />{allow.isSuccess && <p role="status">Rule added.</p>}</li>;
}

export function Domains({ agentId }: { agentId: string }) {
  const interval = usePollInterval();
  const domains = useQuery({ queryKey: ["domains", agentId], queryFn: () => api.domains(agentId), refetchInterval: interval });
  const [pattern, setPattern] = useState("");
  const [attended, setAttended] = useState(false);
  const add = useAction(async () => { await api.addDomain(agentId, pattern, attended); setPattern(""); });
  return <>
    <h2>Domains</h2><ErrorLine error={domains.error} />{domains.isPending && <p role="status">Loading domains…</p>}
    <section><h3>Pending requests</h3>{domains.data?.pending.length === 0 && <p className="muted">No domain requests.</p>}{domains.data?.pending.map(request => <DomainRequestCard key={request.id} request={request} />)}</section>
    <section className="card"><h3>Allowed rules</h3><ul className="domain-list">{domains.data?.rules.map(rule => <DomainRule key={rule.id} rule={rule} />)}</ul>{domains.data?.rules.length === 0 && <p className="muted">No allowed rules.</p>}
      <form className="domain-form" onSubmit={event => { event.preventDefault(); add.mutate(); }}><label>Domain pattern<input placeholder="billing.example.com" value={pattern} onChange={event => setPattern(event.target.value)} required maxLength={255} autoCapitalize="none" autoCorrect="off" /></label><label className="switch"><input type="checkbox" checked={attended} onChange={event => setAttended(event.target.checked)} />Attended only</label><button disabled={add.isPending || !pattern.trim()}>Add permanent rule</button><ErrorLine error={add.error} /></form>
    </section>
    <section className="card"><h3>Recently blocked hosts</h3><p className="muted">Allow adds a permanent rule.</p><ul className="domain-list">{domains.data?.blocked.map(host => <BlockedHost key={host.host} agentId={agentId} host={host} />)}</ul>{domains.data?.blocked.length === 0 && <p className="muted">No recently blocked hosts.</p>}</section>
  </>;
}
