// The bridge the desktop app's preload script exposes to the web app as `window.quokkabotDesktop`. The web app uses it
// only when present. The main process validates every call (sender frame, origin and payload) and stays the authority:
// it signs in, polls for things waiting on the owner, shows notifications and the badge, saves downloads and stops
// agents itself; the page only asks.

export type DesktopFlowResult = "approved" | "refused" | "expired" | "cancelled" | "error";

export interface DesktopFlowStarted {
  // Shown in the app; the browser shows the same code.
  userCode: string;
  expiresAt: string;
}

export interface DesktopSettings {
  launchAtLogin: boolean;
  notifications: boolean;
  // Show the question or request text in notifications (on by default; off shows only "Agent 1 asks a question").
  notificationDetails: boolean;
}

export type DesktopDownloadTarget = { fileId: string } | { agentId: string; path: string };

export interface DesktopUpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "unsupported";
  version: string | null;
  message: string | null;
}

export interface QuokkaBotDesktopBridge {
  readonly platform: "darwin" | "win32" | "linux";
  readonly appVersion: string;
  // Sign-in and the fresh re-check go through the default browser. start* opens the browser and returns the code;
  // waitFor* resolves when the owner approves or refuses there, or the link expires. One flow at a time.
  startSignIn(): Promise<DesktopFlowStarted>;
  startFreshCheck(): Promise<DesktopFlowStarted>;
  waitForFlow(): Promise<DesktopFlowResult>;
  cancelFlow(): Promise<void>;
  // Saves a file to the downloads folder (default ~/Downloads/Quokka Bot) and shows it in Finder when done.
  download(target: DesktopDownloadTarget): Promise<{ name: string }>;
  showDownloads(): Promise<void>;
  // Called when a notification, the menu or the tray asks the app to show a route.
  onNavigate(callback: (route: string) => void): () => void;
  getSettings(): Promise<DesktopSettings>;
  setSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  installUpdate(): Promise<void>;
  // Signs out on this Mac and forgets the server: back to the connect window.
  changeServer(): Promise<void>;
}

export const DESKTOP_ROUTES = {
  home: "/",
  newTask: "/?new=1",
  task: (taskId: string) => `/tasks/${taskId}`,
  agent: (agentId: string, section = "") => `/agents/${agentId}${section ? `/${section}` : ""}`,
} as const;
