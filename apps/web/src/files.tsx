import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ComputerView, FileListing } from "@quokkabot/shared";
import { api, ApiFailure } from "./api.js";
import { DownloadLink } from "./download-link.js";
import { bytesLabel, dateLabel, ErrorLine } from "./ui.js";

function FileEntry({ entry, agentId, scope, openFolder }: {
  entry: FileListing["entries"][number]; agentId: string; scope: "workspace" | "downloads"; openFolder: (path: string) => void;
}) {
  const isDirectory = entry.type === "dir";
  return <li className="file-entry">
    <div>{isDirectory ? <button className="folder-button" onClick={() => openFolder(entry.path)}>{entry.name}/</button> : scope === "downloads" ? entry.file ? <DownloadLink target={{ fileId: entry.file.fileId }} name={entry.name} /> : <ErrorLine error={new Error(`Download ${entry.name} is missing its published file record`)} /> : <DownloadLink target={{ agentId, path: entry.path }} name={entry.name} />}
      <p className="meta">{isDirectory ? "Folder" : bytesLabel(entry.bytes)} · {dateLabel(entry.modifiedAt)}</p>
      {entry.file?.sourceUrl && <p className="meta plain">Source: {entry.file.sourceUrl}</p>}
      {entry.file && <code className="meta hash" title={entry.file.sha256}>SHA-256 {entry.file.sha256.slice(0, 12)}</code>}
    </div>
  </li>;
}

// A computer that is stopped or behind the kill switch is a normal state: the server's answer says what to do.
function computerNotRunning(error: unknown): string | null {
  return error instanceof ApiFailure && error.status === 409 && (error.code === "computer_stopped" || error.code === "killed") ? error.message : null;
}

function FileBrowser({ agentId, scope, computer }: { agentId: string; scope: "downloads" | "workspace"; computer: ComputerView["state"] }) {
  const [dir, setDir] = useState("");
  // The workspace lives on the agent's computer, so a change in the computer's state lists it again.
  const files = useInfiniteQuery({ queryKey: ["files", agentId, scope, dir, scope === "workspace" ? computer : null], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.files(agentId, scope, dir, pageParam), getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const parent = dir.split("/").slice(0, -1).join("/");
  const notRunning = computerNotRunning(files.error);
  return <section className="card file-browser">
    <div className="section-heading"><h3>{scope === "downloads" ? "Downloads" : "Workspace"}</h3><button disabled={files.isFetching} onClick={() => { void files.refetch(); }}>Refresh</button></div>
    {notRunning ? <p className="empty" role="status">{notRunning}</p> : <>
      <div className="file-path"><span className="plain">/{dir}</span>{dir && <button onClick={() => setDir(parent)}>Up a folder</button>}</div>
      <ErrorLine error={files.error} />{files.isPending && <p role="status">Loading files…</p>}
      <ul className="file-list">{files.data?.pages.flatMap(page => page.entries).filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index).map(entry => <FileEntry key={entry.path} entry={entry} agentId={agentId} scope={scope} openFolder={setDir} />)}</ul>
      {files.data?.pages[0]?.entries.length === 0 && <p className="empty">This folder is empty.</p>}
      {files.hasNextPage && <button disabled={files.isFetchingNextPage} onClick={() => { void files.fetchNextPage(); }}>Load more files</button>}
    </>}
  </section>;
}

export function Files({ agentId, computer }: { agentId: string; computer: ComputerView["state"] }) {
  return <><h2>Files</h2><div className="files-grid"><FileBrowser agentId={agentId} scope="downloads" computer={computer} /><FileBrowser agentId={agentId} scope="workspace" computer={computer} /></div></>;
}
