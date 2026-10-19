import type { LinkStart } from "./sign-in";

// The server the owner picked on the server screen, and the link started there. The code and link screens read only
// this, never their route: a link from outside the app (quokkabot://link?…) could name another server for the
// operator's code, or another phone's code for the owner to approve with their passkey.
export type ChosenServer = { origin: string; viewOrigin: string };

let chosen: { server: ChosenServer; link: LinkStart | null } | null = null;

export function chooseServer(server: ChosenServer, link: LinkStart | null = null): void {
  chosen = { server: { origin: server.origin, viewOrigin: server.viewOrigin }, link };
}
export function chosenServer(): ChosenServer | null {
  return chosen?.server ?? null;
}
export function chosenLink(): { server: ChosenServer; link: LinkStart } | null {
  return chosen?.link ? { server: chosen.server, link: chosen.link } : null;
}
export function forgetChosenServer(): void {
  chosen = null;
}
