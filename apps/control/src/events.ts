import { EventEmitter } from "node:events";
import { TaskEvent, type TaskEventEnvelope } from "@quokkabot/shared";
import pg from "pg";
import { type Db, type Tx, many, one, withTx } from "./db.js";

// Task events are stored in order and announced with NOTIFY so every open event stream gets them at once.
export class TaskEvents {
  readonly emitter = new EventEmitter();
  private listener: pg.Client | null = null;

  constructor(private readonly db: Db) {
    this.emitter.setMaxListeners(1000);
  }

  // Allocates the sequence number, inserts and notifies in one transaction. The row lock taken by the update serialises
  // appends for a task, so readers never see event n+1 before event n and a failed insert leaves no gap.
  async append(q: Db | Tx, taskId: string, event: TaskEvent): Promise<TaskEventEnvelope> {
    if (q instanceof pg.Pool) return withTx(q, (tx) => this.appendIn(tx, taskId, event));
    return this.appendIn(q, taskId, event);
  }

  private async appendIn(q: Tx, taskId: string, event: TaskEvent): Promise<TaskEventEnvelope> {
    const { seq } = await one<{ seq: number }>(
      q,
      "update tasks set last_seq = last_seq + 1, updated_at = now() where id = $1 returning last_seq as seq",
      [taskId],
    );
    const row = await one<{ at: Date }>(
      q,
      "insert into task_events (task_id, seq, event) values ($1, $2, $3) returning at",
      [taskId, seq, JSON.stringify(event)],
    );
    await q.query("select pg_notify('task_events', $1)", [`${taskId}:${seq}`]);
    return { taskId: taskId as TaskEventEnvelope["taskId"], seq, at: row.at.toISOString(), event };
  }

  async after(taskId: string, afterSeq: number, limit = 500): Promise<TaskEventEnvelope[]> {
    const rows = await many<{ seq: number; at: Date; event: TaskEvent }>(
      this.db,
      "select seq, at, event from task_events where task_id = $1 and seq > $2 order by seq limit $3",
      [taskId, afterSeq, limit],
    );
    return rows.map((r) => ({ taskId: taskId as TaskEventEnvelope["taskId"], seq: r.seq, at: r.at.toISOString(), event: TaskEvent.parse(r.event) }));
  }

  // One dedicated connection listens; reconnects on failure.
  async listen(connect: () => pg.Client): Promise<void> {
    const client = connect();
    client.on("error", () => {
      this.listener = null;
      setTimeout(() => void this.listen(connect).catch(() => undefined), 2000);
    });
    await client.connect();
    await client.query("listen task_events");
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      const [taskId, seq] = msg.payload.split(":");
      if (taskId && seq) this.emitter.emit(taskId, Number(seq));
    });
    this.listener = client;
  }

  async close(): Promise<void> {
    await this.listener?.end().catch(() => undefined);
  }
}
