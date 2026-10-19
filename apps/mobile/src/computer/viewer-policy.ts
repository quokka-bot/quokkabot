// The live view loads pages of the server's viewer origin only. Every other URL, another site or another app's link
// (tel:, mailto:, an App Store link), is refused inside the view; nothing opens outside the app.
export function viewerMayLoad(url: string, viewOrigin: string): boolean {
  if (url === "about:blank") return true;
  try { return new URL(url).origin === viewOrigin; } catch { return false; }
}
