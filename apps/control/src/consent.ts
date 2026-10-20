import {
  AGENT_PROVIDER,
  AI_CONSENT_ERROR,
  AI_PROVIDERS,
  type AiConsentClient,
  type AiConsentRequest,
  type AiConsentView,
  type AiProvider,
  aiConsentRefusal,
} from "@quokkabot/shared";
import type { AuditLog } from "./audit.js";
import type { SessionInfo } from "./auth.js";
import type { ControlConfig } from "./config.js";
import { type Db, type Tx, maybeOne, one, withTx } from "./db.js";
import { HttpError } from "./errors.js";

export interface ConsentRow {
  granted: boolean;
  disclosure_version: string | null;
  decided_at: Date;
  client: AiConsentClient;
  device_name: string;
}

// What the latest decision means. A withdrawal always blocks; an allow counts only under the current disclosure; with
// no current allow, `required` decides (the hosted cloud refuses, a self-hosted server sends).
export function consentView(latest: ConsentRow | null, required: boolean, provider: AiProvider): AiConsentView {
  const disclosureVersion = AI_PROVIDERS[provider].disclosureVersion;
  const state: AiConsentView["state"] = latest === null ? "not_asked"
    : !latest.granted ? "withdrawn"
    : latest.disclosure_version === disclosureVersion ? "granted"
    : "not_asked";
  return {
    provider,
    disclosureVersion,
    state,
    required,
    allowed: state === "granted" || (state === "not_asked" && !required),
    changedAt: latest?.decided_at.toISOString() ?? null,
    changedBy: latest ? { client: latest.client, deviceName: latest.device_name } : null,
  };
}

// The owner's permission to send each agent's work to its AI provider. Dispatch reads it in the transaction that
// starts a run, holding the agent row shared; a decision holds it exclusively, so a run starts either before a
// withdrawal (and the withdrawal then stops it) or not at all.
export class AiConsents {
  constructor(private readonly db: Db, private readonly config: ControlConfig, private readonly audit: AuditLog) {}

  get required(): boolean {
    return this.config.aiConsentRequired;
  }

  async view(q: Db | Tx, agentId: string, lock: "share" | null = null): Promise<AiConsentView> {
    const agent = await maybeOne<{ generation: number }>(q,
      `select generation from agents where id = $1 and added_at is not null${lock === "share" ? " for share" : ""}`, [agentId]);
    if (!agent) throw new HttpError(404, "unknown_agent", "No such agent.");
    return consentView(await this.latest(q, agentId, agent.generation), this.required, AGENT_PROVIDER);
  }

  // Throws the error the apps show when a send to this agent would not run. It takes no lock: owner actions run it
  // inside transactions that also change the agent row through other connections (a hand-back), and dispatch checks
  // again, under the lock, before anything reaches the model.
  async require(q: Db | Tx, agentId: string): Promise<void> {
    const view = await this.view(q, agentId);
    if (!view.allowed) throw new HttpError(403, AI_CONSENT_ERROR, aiConsentRefusal(view.state));
  }

  async decide(agentId: string, request: AiConsentRequest, session: SessionInfo): Promise<{ view: AiConsentView; withdrawn: boolean }> {
    return withTx(this.db, async (tx) => {
      const agent = await maybeOne<{ generation: number }>(tx,
        "select generation from agents where id = $1 and added_at is not null and removing_at is null for update", [agentId]);
      if (!agent) throw new HttpError(404, "unknown_agent", "No such agent.");
      if (request.allow) {
        if (request.generation !== agent.generation) {
          throw new HttpError(409, "agent_replaced", "This agent was removed. Reload to see the current agents.");
        }
        if (request.disclosureVersion !== AI_PROVIDERS[request.provider].disclosureVersion) {
          throw new HttpError(409, "disclosure_changed", "What is sent to the AI provider changed. Read it again before you allow it.");
        }
      }
      const owner = await maybeOne<{ webauthn_user_id: string }>(tx, "select webauthn_user_id from owner_account where id = 1");
      if (!owner) throw new HttpError(409, "no_owner", "Set up the owner first.");
      const device = await one<{ device_name: string }>(tx, "select device_name from sessions where hash = $1", [session.hash]);
      await tx.query(
        `insert into ai_consents (agent_id, agent_generation, owner_id, provider, granted, disclosure_version, client, device_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [agentId, agent.generation, owner.webauthn_user_id, request.provider, request.allow,
          request.allow ? request.disclosureVersion : null, session.client, device.device_name],
      );
      await this.audit.append(agentId, "owner", request.allow ? "ai_consent.granted" : "ai_consent.withdrawn", {
        provider: request.provider,
        ...(request.allow ? { disclosureVersion: request.disclosureVersion } : {}),
        client: session.client,
        deviceName: device.device_name,
      }, tx);
      return { view: consentView(await this.latest(tx, agentId, agent.generation), this.required, AGENT_PROVIDER), withdrawn: !request.allow };
    });
  }

  // Only decisions by this server's owner about this agent occupant count.
  private async latest(q: Db | Tx, agentId: string, generation: number): Promise<ConsentRow | null> {
    return maybeOne<ConsentRow>(q,
      `select c.granted, c.disclosure_version, c.decided_at, c.client, c.device_name
       from ai_consents c join owner_account o on o.id = 1 and o.webauthn_user_id = c.owner_id
       where c.agent_id = $1 and c.agent_generation = $2 and c.provider = $3
       order by c.id desc limit 1`,
      [agentId, generation, AGENT_PROVIDER]);
  }
}
