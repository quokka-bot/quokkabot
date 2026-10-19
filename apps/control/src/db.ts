import pg from "pg";
import { REACTION_EMOJIS } from "@quokkabot/shared";
import { sitePatterns } from "@quokkabot/shared/node";
import type { ControlConfig } from "./config.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Parse bigint and numeric as JS numbers: every counter here fits in 2^53.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export function createPool(config: ControlConfig, role: "owner" | "app"): Db {
  const db = config.database;
  const pool = new pg.Pool({
    host: db.host,
    port: db.port,
    database: db.name,
    user: role === "owner" ? db.ownerUser : db.appUser,
    password: role === "owner" ? config.secrets.dbOwnerPassword : config.secrets.dbAppPassword,
    max: role === "owner" ? 2 : 20,
    application_name: `quokkabot-control-${role}`,
  });
  // An idle client losing its connection (database restart) must not crash the process; the next query reconnects.
  pool.on("error", (error) => {
    process.stderr.write(`${JSON.stringify({ level: 50, msg: "database connection lost", err: error.message })}\n`);
  });
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(q: Db | Tx, text: string, values: unknown[] = []): Promise<T> {
  const result = await q.query<T>(text, values);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error(`expected one row, got ${result.rows.length}: ${text.slice(0, 80)}`);
  }
  return row;
}

export async function maybeOne<T extends pg.QueryResultRow>(
  q: Db | Tx,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await q.query<T>(text, values);
  if (result.rows.length > 1) throw new Error(`expected at most one row: ${text.slice(0, 80)}`);
  return result.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(q: Db | Tx, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await q.query<T>(text, values);
  return result.rows;
}

// Schema migrations, applied in order by the owner role. Each runs once in its own transaction: its SQL, then its
// data step (for changes SQL cannot compute, such as a site from the Public Suffix List).
type Migration =
  | { id: number; sql: (appUser: string) => string; data?: never }
  | { id: number; sql?: never; data: (tx: Tx) => Promise<void> };
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: (appUser) => `
      create table owner_account (
        id int primary key default 1 check (id = 1),
        name text not null,
        webauthn_user_id text not null,
        created_at timestamptz not null default now()
      );
      create table passkeys (
        id text primary key,
        public_key bytea not null,
        counter bigint not null,
        transports text[] not null default '{}',
        created_at timestamptz not null default now(),
        last_used_at timestamptz
      );
      create table setup_tickets (
        hash text primary key,
        expires_at timestamptz not null,
        used_at timestamptz,
        created_at timestamptz not null default now()
      );
      create table webauthn_challenges (
        id uuid primary key,
        challenge text not null,
        purpose text not null check (purpose in ('setup', 'signin', 'fresh')),
        ticket_hash text,
        session_hash text,
        expires_at timestamptz not null
      );
      create table sessions (
        hash text primary key,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        fresh_until timestamptz,
        revoked_at timestamptz
      );
      create table view_tickets (
        hash text primary key,
        agent_id uuid not null,
        session_hash text not null,
        expires_at timestamptz not null,
        used_at timestamptz
      );
      create table view_sessions (
        hash text primary key,
        agent_id uuid not null,
        session_hash text not null,
        expires_at timestamptz not null
      );

      create table agents (
        id uuid primary key,
        idx int not null unique,
        name text not null,
        model text not null,
        effort text not null,
        cli_signed_in text not null default 'unknown' check (cli_signed_in in ('yes', 'no', 'unknown')),
        killed_at timestamptz,
        lease_holder text not null default 'paused' check (lease_holder in ('agent', 'owner', 'paused')),
        lease_generation bigint not null default 1,
        lease_expires_at timestamptz,
        attended_open boolean not null default false,
        selkies_owner_token text,
        created_at timestamptz not null default now()
      );

      create table tasks (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        title text not null,
        prompt text not null,
        state text not null check (state in ('queued', 'running', 'completed', 'failed', 'outcome_unknown', 'cancelled')),
        blocked_reason text check (blocked_reason in ('waiting_for_owner', 'takeover', 'domain_request', 'attended_session')),
        model text not null,
        effort text not null,
        session_id uuid not null,
        session_started boolean not null default false,
        -- The prompt for the next run. Set when a task is created, answered, resumed or followed up; the dispatcher
        -- starts a run for it and clears it. The database is the queue: one run per agent at a time.
        pending_prompt text,
        result_summary text,
        result_files jsonb,
        error text,
        last_seq int not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index tasks_agent_created on tasks (agent_id, created_at desc);
      create index tasks_pending on tasks (agent_id, updated_at) where pending_prompt is not null;

      create table runs (
        id uuid primary key,
        task_id uuid not null references tasks(id),
        agent_id uuid not null references agents(id),
        attempt int not null,
        state text not null check (state in ('starting', 'running', 'exited', 'lost', 'cancelled')),
        prompt text not null,
        resume boolean not null,
        exit_code int,
        mcp_token_hash text not null unique,
        token_revoked boolean not null default false,
        fenced_at timestamptz,
        fence_reason text,
        output_offset int not null default 0,
        final_result jsonb,
        uncertain_mutations int not null default 0,
        started_at timestamptz not null default now(),
        ended_at timestamptz,
        last_event_at timestamptz,
        unique (task_id, attempt)
      );
      create unique index one_active_run_per_agent on runs (agent_id) where state in ('starting', 'running');

      create table task_events (
        task_id uuid not null references tasks(id),
        seq int not null,
        at timestamptz not null default now(),
        event jsonb not null,
        primary key (task_id, seq)
      );

      create table owner_requests (
        id uuid primary key,
        task_id uuid not null references tasks(id),
        run_id uuid not null references runs(id),
        kind text not null check (kind in ('question', 'takeover')),
        text text not null,
        what_to_do text,
        created_at timestamptz not null default now(),
        answered_at timestamptz,
        answer text
      );

      create table domain_rules (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        pattern text not null,
        attended boolean not null,
        task_id uuid references tasks(id),
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        created_by text not null
      );
      create table domain_requests (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        task_id uuid references tasks(id),
        run_id uuid references runs(id),
        domains text[] not null,
        reason text not null,
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        decision text check (decision in ('allow_task', 'allow_always', 'refuse')),
        attended boolean not null default false
      );
      create table blocked_hosts (
        agent_id uuid not null references agents(id),
        host text not null,
        decision text not null,
        count int not null,
        last_at timestamptz not null,
        task_id uuid,
        primary key (agent_id, host, decision)
      );

      create table files (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        scope text not null check (scope in ('downloads', 'workspace')),
        download_id uuid unique,
        name text not null,
        rel_path text not null,
        bytes bigint not null,
        sha256 text not null,
        mime_type text not null,
        source_url text,
        task_id uuid,
        run_id uuid,
        created_at timestamptz not null default now()
      );
      create index files_agent_scope on files (agent_id, scope, created_at desc);

      create table browser_commands (
        id text primary key,
        agent_id uuid not null,
        run_id uuid not null,
        op text not null,
        status text,
        started_at timestamptz not null default now(),
        finished_at timestamptz
      );

      create table kv (key text primary key, value jsonb not null);

      -- Audit: the application role can read it and append through the function below, never change it.
      create table audit_events (
        agent_id uuid not null,
        seq bigint not null,
        at timestamptz not null,
        actor text not null,
        type text not null,
        data jsonb not null,
        prev_hash text not null,
        hash text not null,
        primary key (agent_id, seq)
      );
      create table audit_heads (agent_id uuid primary key, seq bigint not null, hash text not null);

      create function audit_append(p_agent uuid, p_seq bigint, p_at timestamptz, p_actor text, p_type text,
                                   p_data jsonb, p_prev text, p_hash text) returns void
      language plpgsql security definer set search_path = public, pg_temp as $$
      declare
        head_seq bigint;
        head_hash text;
      begin
        insert into audit_heads (agent_id, seq, hash) values (p_agent, 0, repeat('0', 64)) on conflict do nothing;
        select seq, hash into head_seq, head_hash from audit_heads where agent_id = p_agent for update;
        if p_seq <> head_seq + 1 then raise exception 'audit seq % does not follow %', p_seq, head_seq; end if;
        if p_prev <> head_hash then raise exception 'audit prev hash does not match head'; end if;
        insert into audit_events values (p_agent, p_seq, p_at, p_actor, p_type, p_data, p_prev, p_hash);
        update audit_heads set seq = p_seq, hash = p_hash where agent_id = p_agent;
      end $$;

      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${appUser}') then
          raise exception 'role ${appUser} must exist before migrations';
        end if;
      end $$;
      grant usage on schema public to ${appUser};
      grant select, insert, update, delete on all tables in schema public to ${appUser};
      revoke insert, update, delete, truncate on audit_events, audit_heads from ${appUser};
      grant select on audit_events, audit_heads to ${appUser};
      revoke all on function audit_append(uuid, bigint, timestamptz, text, text, jsonb, text, text) from public;
      grant execute on function audit_append(uuid, bigint, timestamptz, text, text, jsonb, text, text) to ${appUser};
    `,
  },
  {
    id: 2,
    sql: (appUser) => `
      -- A run is finalised once its task state has been decided; recovery finalises runs that ended without it.
      alter table runs add column finalized boolean not null default false;
      alter table runs add column mcp_failed boolean not null default false;
      update runs set finalized = true where state not in ('starting', 'running');
      -- Task history is append-only for the application, like the audit log.
      revoke update, delete, truncate on task_events from ${appUser};
      -- Evidence copies of attached workspace files live under the agent's Downloads (.evidence/), served by file id.
      alter table files add column evidence boolean not null default false;
    `,
  },
  {
    id: 3,
    sql: () => `
      -- Operator self-test runs have no CLI process behind them: run watchers and recovery leave them alone.
      alter table runs add column diagnostic boolean not null default false;
    `,
  },
  {
    id: 4,
    sql: (appUser) => `
      -- Signed-in devices (browser, desktop app) and the desktop app's browser-based sign-in and re-check.
      alter table sessions add column device_name text not null default 'Browser';
      alter table sessions add column last_seen_at timestamptz;
      create table desktop_links (
        id uuid primary key,
        kind text not null check (kind in ('signin', 'fresh')),
        code_hash text not null unique,
        poll_hash text not null unique,
        device_name text not null,
        -- For kind "fresh": the desktop session to mark fresh.
        requester_session_hash text,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        approved_at timestamptz,
        refused_at timestamptz,
        consumed_at timestamptz
      );
      grant select, insert, update, delete on desktop_links to ${appUser};
    `,
  },
  {
    id: 5,
    sql: () => `
      -- Passkey assertions bound to one desktop link: approving a desktop sign-in or re-check takes its own assertion.
      alter table webauthn_challenges drop constraint webauthn_challenges_purpose_check;
      alter table webauthn_challenges add constraint webauthn_challenges_purpose_check check (purpose in ('setup', 'signin', 'fresh', 'link'));
      alter table webauthn_challenges add column link_id uuid;
    `,
  },
  {
    id: 6,
    sql: (appUser) => `
      -- The login vault: passwords and 2FA secrets encrypted with a key that lives outside the database.
      create table logins (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        name text not null,
        sites text[] not null,
        username text not null,
        password_enc bytea not null,
        password_length int not null,
        totp_enc bytea,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_used_at timestamptz
      );
      grant select, insert, update, delete on logins to ${appUser};
      alter table owner_requests drop constraint owner_requests_kind_check;
      alter table owner_requests add constraint owner_requests_kind_check check (kind in ('question', 'takeover', 'login'));
      alter table owner_requests add column site text;
      alter table owner_requests add column login_name text;
    `,
  },
  {
    id: 7,
    sql: () => `
      -- A login request about a saved login that stopped working: updating that login answers it.
      alter table owner_requests add column login_id uuid;
    `,
  },
  {
    id: 8,
    sql: (appUser) => `
      -- Connected apps: the owner approves an app on its own page; the refresh token is encrypted with the vault key.
      create table connectors (
        id uuid primary key,
        agent_id uuid not null references agents(id),
        app text not null check (app in ('gmail')),
        account text not null,
        refresh_enc bytea not null,
        created_at timestamptz not null default now(),
        unique (agent_id, app, account)
      );
      create table connect_states (
        state_hash text primary key,
        agent_id uuid not null references agents(id),
        app text not null,
        created_at timestamptz not null default now(),
        used_at timestamptz
      );
      grant select, insert, update, delete on connectors, connect_states to ${appUser};
      alter table owner_requests drop constraint owner_requests_kind_check;
      alter table owner_requests add constraint owner_requests_kind_check check (kind in ('question', 'takeover', 'login', 'connect'));
      alter table owner_requests add column connector text;
    `,
  },
  {
    id: 9,
    sql: (appUser) => `
      create table message_reactions (
        task_id uuid not null,
        seq int not null,
        "by" text not null check ("by" in ('owner', 'agent')),
        emoji text not null check (emoji in (${REACTION_EMOJIS.map((emoji) => `'${emoji}'`).join(", ")})),
        created_at timestamptz not null default now(),
        primary key (task_id, seq, "by"),
        foreign key (task_id, seq) references task_events(task_id, seq)
      );
      grant select, insert, update, delete on message_reactions to ${appUser};
    `,
  },
  {
    id: 10,
    sql: (appUser) => `
      create table task_creation_keys (
        agent_id uuid not null references agents(id),
        key_hash text not null,
        task_id uuid not null references tasks(id),
        expires_at timestamptz not null,
        primary key (agent_id, key_hash)
      );
      create index task_creation_keys_expiry on task_creation_keys (expires_at);
      grant select, insert, update, delete on task_creation_keys to ${appUser};
    `,
  },
  {
    id: 11,
    sql: (appUser) => `
      create table attachments (
        id uuid primary key,
        agent_id uuid not null references agents(id) on delete cascade,
        task_id uuid references tasks(id) on delete cascade,
        name text not null,
        media_type text not null check (media_type in ('image/png','image/jpeg','image/gif','image/webp')),
        bytes int not null check (bytes > 0 and bytes <= 3932160),
        width int not null check (width between 1 and 8000),
        height int not null check (height between 1 and 8000),
        sha256 text not null,
        data bytea not null,
        created_at timestamptz not null default now()
      );
      create index attachments_unbound on attachments (created_at) where task_id is null;
      create index attachments_task on attachments (task_id);
      alter table tasks add column pending_attachment_ids uuid[] not null default '{}';
      alter table runs add column attachment_ids uuid[] not null default '{}';
      grant select, insert, update, delete on attachments to ${appUser};
    `,
  },
  {
    id: 12,
    sql: () => `
      alter table agents add column added_at timestamptz;
      update agents set added_at = created_at;
      -- A durable fence keeps interrupted removals from starting new work before the owner retries.
      alter table agents add column removing_at timestamptz;
      alter table runs drop constraint runs_task_id_fkey;
      alter table runs add foreign key (task_id) references tasks(id) on delete cascade;
      alter table task_events drop constraint task_events_task_id_fkey;
      alter table task_events add foreign key (task_id) references tasks(id) on delete cascade;
      alter table owner_requests drop constraint owner_requests_task_id_fkey;
      alter table owner_requests add foreign key (task_id) references tasks(id) on delete cascade;
      alter table owner_requests drop constraint owner_requests_run_id_fkey;
      alter table owner_requests add foreign key (run_id) references runs(id) on delete cascade;
      alter table domain_rules drop constraint domain_rules_task_id_fkey;
      alter table domain_rules add foreign key (task_id) references tasks(id) on delete cascade;
      alter table domain_requests drop constraint domain_requests_task_id_fkey;
      alter table domain_requests add foreign key (task_id) references tasks(id) on delete cascade;
      alter table domain_requests drop constraint domain_requests_run_id_fkey;
      alter table domain_requests add foreign key (run_id) references runs(id) on delete cascade;
      alter table message_reactions drop constraint message_reactions_task_id_seq_fkey;
      alter table message_reactions add foreign key (task_id, seq) references task_events(task_id, seq) on delete cascade;
      alter table task_creation_keys drop constraint task_creation_keys_task_id_fkey;
      alter table task_creation_keys add foreign key (task_id) references tasks(id) on delete cascade;
    `,
  },
  {
    id: 13,
    sql: () => `
      alter table agents add column cli_account text, add column cli_plan text;
    `,
  },
  {
    id: 14,
    sql: () => `
      alter table agents add column generation int not null default 1;
      -- Old consent states expire in 15 minutes and cannot identify their slot occupant.
      alter table connect_states add column generation int;
    `,
  },
  {
    id: 15,
    sql: () => `
      -- "skip": the owner wrote a message instead of deciding.
      alter table domain_requests drop constraint domain_requests_decision_check;
      alter table domain_requests add constraint domain_requests_decision_check check (decision in ('allow_task', 'allow_always', 'refuse', 'skip'));
    `,
  },
  {
    id: 16,
    // A login belongs to a site with all its subdomains, as in a password manager: roblox.com becomes *.roblox.com,
    // so it also fills on www.roblox.com.
    data: async (tx) => {
      const logins = await many<{ id: string; sites: string[] }>(tx, "select id, sites from logins");
      for (const login of logins) {
        await tx.query("update logins set sites = $2 where id = $1", [login.id, sitePatterns(login.sites)]);
      }
    },
  },
  {
    id: 17,
    sql: () => `
      -- Which app a session belongs to. Browser and desktop sessions travel in the session cookie, phone sessions in
      -- an Authorization header. Desktop sessions are the ones a desktop link named; passkey sign-ins kept 'Browser'.
      alter table sessions add column client text not null default 'browser' check (client in ('browser', 'desktop', 'phone'));
      update sessions set client = 'desktop' where device_name <> 'Browser';
      -- A phone session's expiry moves forward with use, never past this.
      alter table sessions add column absolute_expires_at timestamptz;
      alter table sessions add constraint sessions_phone_absolute_check check (client <> 'phone' or absolute_expires_at is not null);
    `,
  },
];

export async function migrate(config: ControlConfig): Promise<void> {
  const ownerPool = createPool(config, "owner");
  try {
    const appUser = config.database.appUser;
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(appUser)) throw new Error("invalid app role name");
    // The app role and its password are managed here so a fresh database needs nothing but the owner account.
    const exists = await ownerPool.query("select 1 from pg_roles where rolname = $1", [appUser]);
    const password = config.secrets.dbAppPassword.replaceAll("'", "''");
    if (exists.rowCount === 0) {
      await ownerPool.query(`create role ${appUser} login password '${password}'`);
    } else {
      await ownerPool.query(`alter role ${appUser} login password '${password}'`);
    }
    await ownerPool.query("create table if not exists schema_migrations (id int primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await ownerPool.query<{ id: number }>("select id from schema_migrations")).rows.map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await withTx(ownerPool, async (tx) => {
        if (migration.sql) await tx.query(migration.sql(appUser));
        if (migration.data) await migration.data(tx);
        await tx.query("insert into schema_migrations (id) values ($1)", [migration.id]);
      });
    }
  } finally {
    await ownerPool.end();
  }
}
