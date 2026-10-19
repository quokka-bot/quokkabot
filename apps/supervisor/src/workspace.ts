import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, RelPath } from "@quokkabot/shared";

// Directory descriptors anchor every Linux lookup even if the sandbox renames a parent while we write.
export async function writeWorkspaceBinary(root: string, path: string, data: Buffer, own: (path: string) => Promise<void>): Promise<void> {
  if (!RelPath.safeParse(path).success || path === "" || path === "." || path.includes("\\")) throw new Error("Expected a relative workspace file path without traversal");
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error("Workspace image exceeds the size limit");
  const parts = path.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error("Invalid workspace path");
  const handles: FileHandle[] = [];
  let parent = root;
  let temporary: string | undefined;
  try {
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(rootHandle);
    if (process.platform === "linux") parent = `/proc/self/fd/${rootHandle.fd}`;
    for (const part of parts.slice(0, -1)) {
      const next = join(parent, part);
      let created = false;
      try { await mkdir(next, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const handle = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      if (created) await own(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : next);
      parent = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : next;
    }
    const target = join(parent, parts.at(-1)!);
    const checkTarget = async () => {
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Refusing a symlink or special workspace file");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    await checkTarget();
    temporary = join(parent, `.attachment-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await own(process.platform === "linux" ? `/proc/self/fd/${file.fd}` : temporary); await file.sync(); }
    finally { await file.close(); }
    await checkTarget();
    await rename(temporary, target);
    temporary = undefined;
    await handles.at(-1)!.sync();
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    for (const handle of handles.reverse()) await handle.close();
  }
}
