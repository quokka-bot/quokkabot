import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeOAuthToken, type ClaudeSignInView } from "@quokkabot/shared";
import { atomicWrite, directory, durableRemove, isMissing } from "./storage.js";

const StoredToken = z.object({ id: z.uuid(), token: ClaudeOAuthToken, signedInAt: z.iso.datetime() }).strict();
type StoredToken = z.infer<typeof StoredToken>;

// The Claude sign-in all agents share: one long-lived token from `claude setup-token`, in a supervisor-only directory
// on the encrypted volume. No sandbox mounts it and backups leave it out. The id is the sign-in that created it, so a
// late expiry report from an older sign-in cannot remove a newer one.
export class ClaudeTokenStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}

  private get path(): string { return join(this.root, "token.json"); }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => undefined).then(action);
    this.queue = current;
    return current;
  }

  async initialize(): Promise<void> { await directory(this.root); }

  private async load(): Promise<StoredToken | null> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    // Parse errors can quote the file. Report only that it is unreadable.
    try { return StoredToken.parse(JSON.parse(text)); }
    catch { throw new Error("The stored Claude sign-in is unreadable"); }
  }

  token(): Promise<string | null> { return this.serial(async () => (await this.load())?.token ?? null); }

  view(): Promise<ClaudeSignInView> {
    return this.serial(async () => {
      const stored = await this.load();
      return { signedIn: stored !== null, signedInAt: stored?.signedInAt ?? null };
    });
  }

  save(id: string, token: string): Promise<ClaudeSignInView> {
    return this.serial(async () => {
      const stored = StoredToken.parse({ id, token, signedInAt: new Date().toISOString() });
      await atomicWrite(this.path, JSON.stringify(stored));
      return { signedIn: true, signedInAt: stored.signedInAt };
    });
  }

  // Without an id: the owner's sign-out, whatever is stored. With an id: only the sign-in that id created.
  remove(id?: string): Promise<boolean> {
    return this.serial(async () => {
      const stored = await this.load().catch((error: unknown) => { if (id === undefined) return null; throw error; });
      if (id !== undefined && stored?.id !== id) return false;
      await durableRemove(this.path);
      return true;
    });
  }
}
