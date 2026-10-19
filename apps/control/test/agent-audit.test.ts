import { expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import type { Db } from "../src/db.js";

it("shows only the current agent incarnation while verification reads the entire chain", async () => {
  const rows: Record<string, unknown>[] = [];
  let addedAt: Date | null = null;
  const query = async (sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("select seq, hash from audit_heads")) {
      const row = rows.at(-1);
      return { rows: row ? [{ seq: row.seq, hash: row.hash }] : [] };
    }
    if (sql.startsWith("select audit_append")) {
      rows.push({ agent_id: values[0], seq: values[1], at: new Date(String(values[2])), actor: values[3], type: values[4],
        data: JSON.parse(String(values[5])), prev_hash: values[6], hash: values[7] });
      return { rows: [] };
    }
    if (sql.includes("from audit_events")) {
      let page = [...rows];
      if (sql.includes("select added_at")) {
        const latestAdded = rows.filter(row => row.type === "agent.added").at(-1);
        page = page.filter(row => addedAt && (row.at as Date) >= addedAt && Number(row.seq) >= Number(latestAdded?.seq ?? 0) && (values[1] === null || Number(row.seq) < Number(values[1]))).reverse();
      }
      return { rows: page };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
  const audit = new AuditLog(db, Buffer.alloc(32, 1));
  await audit.append("agent", "owner", "agent.created", { name: "Old agent" });
  await audit.append("agent", "owner", "agent.removed", {});
  const added = await audit.append("agent", "owner", "agent.added", { name: "New agent" });
  addedAt = new Date(added.at);
  await audit.append("agent", "owner", "agent.settings_changed", { name: "Accounts" });
  expect((await audit.page("agent", null)).map(event => event.type)).toEqual(["agent.settings_changed", "agent.added"]);
  expect(await audit.page("agent", 3)).toEqual([]);
  expect(await audit.verify("agent")).toMatchObject({ ok: true, count: 4 });
});
