import type { DesktopDownloadTarget } from "@quokkabot/shared";
import { api, fileDownloadUrl, workspaceDownloadUrl } from "./api.js";
import { ErrorLine, useAction } from "./ui.js";

export function DownloadLink({ target, name }: { target: DesktopDownloadTarget; name: string }) {
  const url = "fileId" in target ? fileDownloadUrl(target.fileId) : workspaceDownloadUrl(target.agentId, target.path);
  const download = useAction(async () => {
    if (window.quokkabotDesktop) await window.quokkabotDesktop.download(target);
    else await api.downloadFile(url, name);
  });
  return <>
    {window.quokkabotDesktop ? <button className="file-link" disabled={download.isPending} onClick={() => download.mutate()}>{name}</button> : <a className="file-link" href={url} download={name} aria-disabled={download.isPending} onClick={event => {
      event.preventDefault();
      if (!download.isPending) download.mutate();
    }}>{name}</a>}
    {download.isPending && <span className="meta" role="status">Preparing download…</span>}
    <ErrorLine error={download.error} />
  </>;
}
