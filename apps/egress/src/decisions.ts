import { randomUUID } from "node:crypto";
import type { EgressDecisionEvent } from "@quokkabot/shared";

/** A fixed-size ring: polling never consumes events needed by another control-plane reader. */
export class DecisionStore {
  // The epoch and sequence share a lifetime, including when the service is embedded in another process.
  readonly epoch = randomUUID();
  private readonly ring: (EgressDecisionEvent | undefined)[] = new Array(10_000);
  private next = 0;
  private sequence = 0;
  private readonly waiters = new Set<() => void>();

  append(event: Omit<EgressDecisionEvent, "seq">): EgressDecisionEvent {
    const complete = { ...event, seq: ++this.sequence };
    this.ring[this.next] = complete;
    this.next = (this.next + 1) % this.ring.length;
    for (const notify of [...this.waiters]) notify();
    return complete;
  }

  after(sequence: number): EgressDecisionEvent[] {
    const first = Math.max(sequence + 1, this.sequence - this.ring.length + 1, 1);
    const result: EgressDecisionEvent[] = [];
    for (let seq = first; seq <= this.sequence; seq++) {
      const event = this.ring[(seq - 1) % this.ring.length];
      if (event !== undefined) result.push(event);
    }
    return result;
  }

  wait(after: number, milliseconds: number, signal: AbortSignal): Promise<EgressDecisionEvent[]> {
    const existing = this.after(after);
    if (existing.length > 0 || milliseconds === 0 || signal.aborted) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal.removeEventListener("abort", finish);
        resolve(this.after(after));
      };
      const check = (): void => { if (this.after(after).length > 0) finish(); };
      const timer = setTimeout(finish, milliseconds);
      timer.unref();
      this.waiters.add(check);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
