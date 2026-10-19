import { useEffect, useState } from "react";
import { z } from "zod";

const VersionFile = z.object({ entry: z.string().regex(/^assets\/[\w.-]+\.js$/) });
export const VERSION_CHECK_MS = 60_000;
// The entry a reload was started for: a server whose version.json disagrees with its index.html gets one reload, not one per blur.
const RELOADED_FOR = "quokkabot-reloaded-for";
const reloadPage = () => window.location.reload();

/** The running entry chunk as version.json names it, from the entry module's own URL. */
export function entryFromModuleUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

// Fields the owner typed in. A value the app filled in (a login card's username, an agent's name) is not unsent text.
const typed = new WeakSet<EventTarget>();
let watchingInput = false;
export function watchTyping(): void {
  if (watchingInput) return;
  watchingInput = true;
  document.addEventListener("input", event => { if (event.target) typed.add(event.target); }, true);
}

/** Text the owner typed and has not sent, an image draft, a terminal or a takeover: reloading would lose it. */
export function holdsReload(): boolean {
  if (document.querySelector("[data-hold-reload]")) return true;
  const skipped = new Set(["hidden", "checkbox", "radio", "file", "button", "submit", "reset", "range", "color"]);
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")) {
    if (typed.has(field) && !skipped.has(field.type) && field.value.trim() !== "") return true;
  }
  return false;
}

/**
 * Notices a deploy while the window is open. The new app loads by itself the next time the window is in the background
 * and nothing unsent would be lost; until then a Reload button is shown.
 */
export function NewVersion({ entry, reload = reloadPage }: { entry: string; reload?: () => void }) {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    watchTyping();
    let alive = true;
    const check = async () => {
      try {
        const response = await fetch("/version.json", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const current = VersionFile.parse(await response.json()).entry;
        if (alive && current !== entry) setLatest(current);
      } catch (error) {
        // The server may be restarting for this very deploy; the next check tries again.
        console.warn("Quokka Bot version check failed", error);
      }
    };
    void check();
    const timer = setInterval(() => void check(), VERSION_CHECK_MS);
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [entry]);
  useEffect(() => {
    if (latest === null || sessionStorage.getItem(RELOADED_FOR) === latest) return;
    const reloadWhenAway = () => {
      if ((document.visibilityState === "visible" && document.hasFocus()) || holdsReload()) return;
      sessionStorage.setItem(RELOADED_FOR, latest);
      reload();
    };
    reloadWhenAway();
    window.addEventListener("blur", reloadWhenAway);
    document.addEventListener("visibilitychange", reloadWhenAway);
    return () => { window.removeEventListener("blur", reloadWhenAway); document.removeEventListener("visibilitychange", reloadWhenAway); };
  }, [latest, reload]);
  if (latest === null) return null;
  return <div className="update-notice" role="status">Quokka Bot was updated. <button type="button" className="link-button" onClick={reload}>Reload</button></div>;
}
