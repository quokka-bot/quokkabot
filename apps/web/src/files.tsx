import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { FileListing } from "@quokkabot/shared";
import { api } from "./api.js";
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

function FileBrowser({ agentId, scope }: { agentId: string; scope: "downloads" | "workspace" }) {
  const [dir, setDir] = useState("");
  const files = useInfiniteQuery({ queryKey: ["files", agentId, scope, dir], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.files(agentId, scope, dir, pageParam), getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const parent = dir.split("/").slice(0, -1).join("/");
  return <section className="card file-browser">
    <div className="section-heading"><h3>{scope === "downloads" ? "Downloads" : "Workspace"}</h3><button disabled={files.isFetching} onClick={() => { void files.refetch(); }}>Refresh</button></div>
    <div className="file-path"><span className="plain">/{dir}</span>{dir && <button onClick={() => setDir(parent)}>Up a folder</button>}</div>
    <ErrorLine error={files.error} />{files.isPending && <p role="status">Loading files…</p>}
    <ul className="file-list">{files.data?.pages.flatMap(page => page.entries).filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index).map(entry => <FileEntry key={entry.path} entry={entry} agentId={agentId} scope={scope} openFolder={setDir} />)}</ul>
    {files.data?.pages[0]?.entries.length === 0 && <p className="empty">This folder is empty.</p>}
    {files.hasNextPage && <button disabled={files.isFetchingNextPage} onClick={() => { void files.fetchNextPage(); }}>Load more files</button>}
  </section>;
}

export function Files({ agentId }: { agentId: string }) {
  return <><h2>Files</h2><div className="files-grid"><FileBrowser agentId={agentId} scope="downloads" /><FileBrowser agentId={agentId} scope="workspace" /></div></>;
}
