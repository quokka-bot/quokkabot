import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthentication } from "@simplewebauthn/browser";
import { LoginView, type QuokkaBotDesktopBridge, type DesktopFlowResult, type DesktopSettings } from "@quokkabot/shared";
import { App } from "../src/app.js";
import { api } from "../src/api.js";
import { DownloadLink } from "../src/download-link.js";
import { agent, agentId, at, detail, json, me, ownerRequest, task, taskId } from "./fixtures.js";

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
vi.mock("../src/terminal-session.js", () => ({ default: () => <div>Terminal connected</div> }));

const code = "ABCD-2345";
const flow = { userCode: code, expiresAt: "2026-10-17T18:00:00.000Z" };
const loginId = "66666666-6666-4666-8666-666666666666";
const savedLogin = LoginView.parse({ id: loginId, agentId, name: "Billing", sites: ["billing.example.com"], username: "owner@example.com", passwordLength: 19, hasTotp: true, createdAt: at, updatedAt: at, lastUsedAt: null });
const linkRequest = { ...ownerRequest, kind: "login" as const, site: "billing.example.com", loginName: "Billing", text: "I need the October invoice." };
let clients: QueryClient[];
let handler: (path: string, init: RequestInit | undefined) => Response | undefined;
const fetchMock = vi.fn<typeof fetch>();
let logins: LoginView[];
let devices: { id: string; deviceName: string; client: "browser" | "desktop" | "phone"; current: boolean; createdAt: string; lastSeenAt: string | null }[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function bridge() {
  let settings: DesktopSettings = { launchAtLogin: false, notifications: true, notificationDetails: true };
  const result = {
    platform: "darwin", appVersion: "1.2.3",
    startSignIn: vi.fn(async () => flow), startFreshCheck: vi.fn(async () => flow),
    waitForFlow: vi.fn<QuokkaBotDesktopBridge["waitForFlow"]>(async () => "approved"), cancelFlow: vi.fn(async () => {}),
    download: vi.fn<QuokkaBotDesktopBridge["download"]>(async () => ({ name: "invoice.pdf" })), showDownloads: vi.fn(async () => {}),
    onNavigate: vi.fn<QuokkaBotDesktopBridge["onNavigate"]>(() => vi.fn()),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn<QuokkaBotDesktopBridge["setSettings"]>(async patch => { settings = { ...settings, ...patch }; return settings; }),
    getUpdateStatus: vi.fn<QuokkaBotDesktopBridge["getUpdateStatus"]>(async () => ({ state: "ready", version: "1.2.4", message: "Ready to install" })),
    installUpdate: vi.fn(async () => {}), changeServer: vi.fn(async () => {}),
  } satisfies QuokkaBotDesktopBridge;
  vi.stubGlobal("quokkabotDesktop", result);
  return result;
}

function mount(path = "/", children: ReactNode = <App />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>);
}

function body(path: string, method = "POST") {
  const call = fetchMock.mock.calls.find(([url, init]) => url === path && init?.method === method);
  if (!call) throw new Error(`Missing ${method} ${path}`);
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

function change(label: string | RegExp, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }

beforeEach(() => {
  clients = []; logins = [savedLogin];
  devices = [{ id: "this", deviceName: "This Mac", client: "desktop", current: true, createdAt: at, lastSeenAt: at }, { id: "other", deviceName: "Other Mac", client: "desktop", current: false, createdAt: at, lastSeenAt: null }];
  handler = () => undefined;
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, "", "/");
  vi.stubGlobal("EventSource", class { close() {} });
  vi.mocked(startAuthentication).mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const custom = handler(path, init);
    if (custom) return custom;
    if (path === "/api/me") return json(me);
    if (path === "/api/agents") return json({ agents: [agent], capacity: { used: 1, total: 2 } });
    if (path === "/api/inbox") return json({ items: [] });
    if (path === `/api/agents/${agentId}`) return json(agent);
    if (path === `/api/tasks/${taskId}`) return json(detail);
    if (path.startsWith(`/api/agents/${agentId}/tasks?`)) return json({ tasks: [task], nextBefore: null });
    if (path === "/api/sessions") return json({ sessions: devices });
    if (path.startsWith("/api/sessions/") && init?.method === "DELETE") { devices = devices.filter(device => path !== `/api/sessions/${device.id}`); return json({}); }
    if (path === `/api/agents/${agentId}/logins` && init?.method === "GET") return json({ logins });
    if (path === `/api/agents/${agentId}/logins` && init?.method === "POST") {
      const input = JSON.parse(String(init.body)) as Record<string, unknown>;
      const created = LoginView.parse({ ...savedLogin, ...input, passwordLength: String(input.password).length, hasTotp: !!input.totp });
      logins = [created]; return json(created);
    }
    if (path === `/api/logins/${loginId}` && init?.method === "PUT") {
      const input = JSON.parse(String(init.body)) as Record<string, unknown>;
      const updated = LoginView.parse({ ...savedLogin, ...input });
      logins = [updated]; return json(updated);
    }
    if (path === `/api/logins/${loginId}` && init?.method === "DELETE") { logins = []; return json({}); }
    if (path === `/api/desktop-link/pending?code=${code}`) return json({ kind: "signin", client: "desktop", deviceName: "Office Mac", createdAt: at, expiresAt: flow.expiresAt });
    if (path === "/api/desktop-link/approve/options" || path === "/api/auth/options") return json({ challenge: "link-bound-challenge", userVerification: "required" });
    if (path === "/api/desktop-link/approve/verify" || path === "/api/desktop-link/refuse") return json({});
    throw new Error(`Unexpected ${init?.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { cleanup(); clients.forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("desktop browser confirmation", () => {
  it("shows the code until approved and then goes home without a renderer passkey", async () => {
    const desktop = bridge(); const result = deferred<DesktopFlowResult>();
    desktop.waitForFlow.mockReturnValue(result.promise);
    mount("/signin");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with your browser" }));
    expect(await screen.findByText(code)).toBeTruthy();
    expect(screen.getByText("Approve this code in your browser")).toBeTruthy();
    expect(desktop.startSignIn).toHaveBeenCalledOnce();
    await act(async () => result.resolve("approved"));
    expect(await screen.findByRole("navigation", { name: "Agents" })).toBeTruthy();
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(desktop.cancelFlow).not.toHaveBeenCalled();
  });

  it.each(["refused", "expired", "cancelled", "error"] as const)("shows %s and permits a new flow", async result => {
    const desktop = bridge(); desktop.waitForFlow.mockResolvedValueOnce(result);
    mount("/signin");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with your browser" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(result === "error" ? /failed/ : new RegExp(result));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("navigation", { name: "Agents" })).toBeTruthy();
    expect(desktop.startSignIn).toHaveBeenCalledTimes(2);
  });

  it("cancels through main and cancels an active flow on unmount", async () => {
    const desktop = bridge(); const result = deferred<DesktopFlowResult>();
    desktop.waitForFlow.mockReturnValue(result.promise);
    desktop.cancelFlow.mockImplementation(async () => result.resolve("cancelled"));
    const view = mount("/signin");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with your browser" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cancelled");
    expect(desktop.cancelFlow).toHaveBeenCalledOnce();
    const again = deferred<DesktopFlowResult>(); desktop.waitForFlow.mockReturnValue(again.promise);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(code); view.unmount();
    expect(desktop.cancelFlow).toHaveBeenCalledTimes(2);
  });

  it("shows bridge start failures", async () => {
    const desktop = bridge(); desktop.startSignIn.mockRejectedValue(new Error("Default browser could not open"));
    mount("/signin"); fireEvent.click(screen.getByRole("button", { name: "Sign in with your browser" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Default browser could not open");
    expect(desktop.waitForFlow).not.toHaveBeenCalled();
  });

  it("requires bridge approval before releasing the kill switch, including retry after refusal", async () => {
    const desktop = bridge(); desktop.waitForFlow.mockResolvedValueOnce("refused");
    handler = path => path === `/api/agents/${agentId}` ? json({ ...agent, computer: { ...agent.computer, state: "killed", killedAt: at } }) : path === `/api/agents/${agentId}/kill/release` ? json(agent.computer) : undefined;
    mount(`/agents/${agentId}/computer`);
    fireEvent.click(await screen.findByRole("button", { name: "Release kill switch" }));
    await screen.findByText("Browser confirmation refused.");
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/kill/release"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(body(`/api/agents/${agentId}/kill/release`)).toEqual({}));
    expect(desktop.startFreshCheck).toHaveBeenCalledTimes(2);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("opens the terminal only after bridge fresh approval", async () => {
    const desktop = bridge(); const result = deferred<DesktopFlowResult>(); desktop.waitForFlow.mockReturnValue(result.promise);
    handler = path => path === `/api/agents/${agentId}` ? json({ ...agent, computer: { ...agent.computer, state: "running" } }) : undefined;
    mount(`/agents/${agentId}/terminal`);
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal with browser confirmation" }));
    await screen.findByText(code);
    expect(screen.queryByText("Terminal connected")).toBeNull();
    await act(async () => result.resolve("approved"));
    await screen.findByText("Terminal connected");
    expect(desktop.startFreshCheck).toHaveBeenCalledOnce(); expect(startAuthentication).not.toHaveBeenCalled();
  });
});

describe("browser desktop-link page", () => {
  it("removes the fragment and approves with the link options and assertion", async () => {
    window.history.replaceState({}, "", `/link#${code}`);
    const assertion = { id: "passkey-assertion" };
    vi.mocked(startAuthentication).mockResolvedValue(assertion as Awaited<ReturnType<typeof startAuthentication>>);
    mount("/link"); await screen.findByText("Office Mac");
    expect(window.location.hash).toBe(""); expect(sessionStorage.getItem("quokkabot:desktop-link-code")).toBe(code);
    expect(screen.getByRole("heading", { name: "Connect the desktop app" })).toBeTruthy();
    expect(screen.getByText("Only approve if the desktop app shows the same code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved. Return to the desktop app.");
    expect(body("/api/desktop-link/approve/options")).toEqual({ userCode: code });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "link-bound-challenge", userVerification: "required" } });
    expect(body("/api/desktop-link/approve/verify")).toEqual({ userCode: code, response: assertion });
    const paths = fetchMock.mock.calls.map(([path]) => path);
    expect(paths.indexOf("/api/desktop-link/approve/options")).toBeLessThan(paths.indexOf("/api/desktop-link/approve/verify"));
    expect(sessionStorage.getItem("quokkabot:desktop-link-code")).toBeNull();
  });

  it("refuses a fresh check without requesting a passkey assertion", async () => {
    window.history.replaceState({}, "", `/link#${code}`);
    handler = path => path.includes("/desktop-link/pending?") ? json({ kind: "fresh", client: "desktop", deviceName: "Office Mac", createdAt: at, expiresAt: flow.expiresAt }) : undefined;
    mount("/link"); await screen.findByText(/wants to confirm an action/);
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
    await screen.findByText("Refused.");
    expect(body("/api/desktop-link/refuse")).toEqual({ userCode: code }); expect(startAuthentication).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("quokkabot:desktop-link-code")).toBeNull();
  });

  it("signs in with a passkey and returns to the saved code", async () => {
    window.history.replaceState({}, "", `/link#${code}`);
    let signedIn = false;
    handler = path => {
      if (path === "/api/me" && !signedIn) return json({ error: { code: "unauthorized", message: "Sign in first" } }, 401);
      if (path === "/api/auth/verify") { signedIn = true; return json(me); }
      return undefined;
    };
    vi.mocked(startAuthentication).mockResolvedValue({ id: "signin" } as Awaited<ReturnType<typeof startAuthentication>>);
    mount("/link");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with passkey" }));
    await screen.findByText("Office Mac"); expect(screen.getByText(code)).toBeTruthy();
    expect(window.location.hash).toBe(""); expect(sessionStorage.getItem("quokkabot:desktop-link-code")).toBe(code);
  });

  it("does not approve when the passkey ceremony fails", async () => {
    window.history.replaceState({}, "", `/link#${code}`);
    vi.mocked(startAuthentication).mockRejectedValue(new Error("Passkey cancelled"));
    mount("/link"); fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Passkey cancelled");
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/desktop-link/approve/verify")).toBe(false);
    expect(screen.queryByText("Approved. Return to the desktop app.")).toBeNull();
  });

  it("names the iPhone app when a phone asks", async () => {
    window.history.replaceState({}, "", `/link#${code}`);
    handler = path => path.includes("/desktop-link/pending?") ? json({ kind: "signin", client: "phone", deviceName: "Owner's iPhone", createdAt: at, expiresAt: flow.expiresAt }) : undefined;
    vi.mocked(startAuthentication).mockResolvedValue({ id: "passkey-assertion" } as Awaited<ReturnType<typeof startAuthentication>>);
    mount("/link");
    // Until the request loads, the page names no app.
    expect(screen.getByRole("heading", { name: "Connect an app" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Checking the request…");
    await screen.findByText("Owner's iPhone");
    expect(screen.getByRole("heading", { name: "Connect the iPhone app" })).toBeTruthy();
    expect(screen.getByText("Only approve if the iPhone app shows the same code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved. Return to the iPhone app.");
  });

  it("rejects missing or malformed codes before making a request", async () => {
    window.history.replaceState({}, "", "/link#bad-code"); mount("/link");
    expect(screen.getByRole("alert").textContent).toContain("missing or invalid");
    expect(fetchMock).not.toHaveBeenCalled(); expect(window.location.hash).toBe("");
  });
});

describe("settings and native navigation", () => {
  it("lists devices, last seen and current marker, and revokes another device", async () => {
    mount("/settings"); await screen.findByText("Other Mac");
    expect(screen.getByText("This device")).toBeTruthy(); expect(screen.getByText("Mac app · Last seen: Never")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out Other Mac" }));
    await waitFor(() => expect(screen.queryByText("Other Mac")).toBeNull());
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/sessions/other" && init?.method === "DELETE")).toBe(true);
    expect(screen.queryByText("Desktop app")).toBeNull();
  });

  it("shows this server's address as a QR code and opens the approval for a phone's code", async () => {
    mount("/settings");
    const qr = await screen.findByRole("img", { name: `QR code for ${window.location.origin}` });
    expect(qr.querySelectorAll("rect").length).toBeGreaterThan(50);
    const approve = screen.getByRole("button", { name: "Approve the phone" });
    change("Code shown on the phone", "abcd-efg");
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    change("Code shown on the phone", code.toLowerCase());
    fireEvent.click(approve);
    await screen.findByText("Office Mac");
    expect(screen.getByText(code)).toBeTruthy();
  });

  it("routes to sign-in after revoking the current device", async () => {
    mount("/settings"); fireEvent.click(await screen.findByRole("button", { name: "Sign out This Mac" }));
    await screen.findByRole("heading", { name: "Sign in to Quokka Bot" });
  });

  it("edits all desktop preferences and invokes downloads, server and ready-update controls", async () => {
    const desktop = bridge(); mount("/settings");
    const launch = await screen.findByRole("checkbox", { name: "Launch at login" });
    expect((launch as HTMLInputElement).checked).toBe(false);
    fireEvent.click(launch); await waitFor(() => expect(desktop.setSettings).toHaveBeenCalledWith({ launchAtLogin: true }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Launch at login" }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "Notifications" }));
    await waitFor(() => expect(desktop.setSettings).toHaveBeenCalledWith({ notifications: false }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Notifications" }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show details in notifications" }));
    await waitFor(() => expect(desktop.setSettings).toHaveBeenCalledWith({ notificationDetails: false }));
    fireEvent.click(screen.getByRole("button", { name: "Show downloads folder" })); fireEvent.click(screen.getByRole("button", { name: "Change server" })); fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await waitFor(() => { expect(desktop.showDownloads).toHaveBeenCalledOnce(); expect(desktop.changeServer).toHaveBeenCalledOnce(); expect(desktop.installUpdate).toHaveBeenCalledOnce(); });
    expect(screen.getByText("App version: 1.2.3")).toBeTruthy(); expect(screen.getByText("Update status: ready (1.2.4)")).toBeTruthy();
  });

  it("shows bridge settings errors and hides restart while downloading", async () => {
    const desktop = bridge(); desktop.setSettings.mockRejectedValue(new Error("Login item could not be changed"));
    desktop.getUpdateStatus.mockResolvedValue({ state: "downloading", version: "1.2.4", message: null });
    mount("/settings"); fireEvent.click(await screen.findByRole("checkbox", { name: "Launch at login" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Login item could not be changed");
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Launch at login" }) as HTMLInputElement).checked).toBe(false);
  });

  it("routes onNavigate, focuses the new-task box and unsubscribes", async () => {
    const desktop = bridge(); const unsubscribe = vi.fn(); desktop.onNavigate.mockReturnValue(unsubscribe);
    const view = mount(); await screen.findByRole("navigation", { name: "Agents" });
    const callback = desktop.onNavigate.mock.calls.at(-1)?.[0]; if (!callback) throw new Error("No native navigation subscription");
    act(() => callback(`/agents/${agentId}/logins`)); await screen.findByRole("heading", { name: "Logins" });
    act(() => callback(`/agents/${agentId}?new=1`)); const box = await screen.findByRole("textbox", { name: "New task" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    view.unmount(); expect(unsubscribe).toHaveBeenCalled();
    expect(() => callback("https://other.example/")).toThrow("app route");
  });
});

describe("downloads", () => {
  it.each([{ fileId: loginId }, { agentId, path: "invoices/October.pdf" }])("passes the typed target to main: %j", async target => {
    const desktop = bridge(); mount("/", <DownloadLink target={target} name="invoice.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "invoice.pdf" }));
    await waitFor(() => expect(desktop.download).toHaveBeenCalledWith(target)); expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("preserves browser download links and existing response handling", async () => {
    const download = vi.spyOn(api, "downloadFile").mockResolvedValue();
    mount("/", <DownloadLink target={{ agentId, path: "invoices/October.pdf" }} name="invoice.pdf" />);
    const link = screen.getByRole("link", { name: "invoice.pdf" });
    expect(link.getAttribute("href")).toBe(`/api/agents/${agentId}/workspace-file?path=invoices%2FOctober.pdf`);
    fireEvent.click(link); await waitFor(() => expect(download).toHaveBeenCalledWith(link.getAttribute("href"), "invoice.pdf"));
  });

  it("shows a failed native save", async () => {
    const desktop = bridge(); desktop.download.mockRejectedValue(new Error("Download folder is not writable"));
    mount("/", <DownloadLink target={{ fileId: loginId }} name="invoice.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "invoice.pdf" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Download folder is not writable");
  });
});

describe("write-only logins", () => {
  it("lists metadata and adds a login using validated comma-separated sites and 2FA", async () => {
    mount(`/agents/${agentId}/logins`); await screen.findByRole("heading", { name: "Billing" });
    expect(screen.getByText("Password: 19 characters · 2FA on")).toBeTruthy(); expect(screen.getByText("Last used: Never")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    change("Name", "Vendor"); change("Sites", "example.com, *.EXAMPLE.com"); change("Username", "account"); change("Password", "new password"); change("2FA secret (optional)", "JBSWY3DPEHPK3PXP");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" })); expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await screen.findByRole("heading", { name: "Vendor" });
    expect(body(`/api/agents/${agentId}/logins`)).toEqual({ name: "Vendor", sites: ["example.com", "*.example.com"], username: "account", password: "new password", totp: "JBSWY3DPEHPK3PXP" });
    expect(screen.queryByLabelText("Password")).toBeNull(); expect(screen.queryByDisplayValue("new password")).toBeNull();
  });

  it("omits an empty password and 2FA on edit so saved values are kept", async () => {
    mount(`/agents/${agentId}/logins`); fireEvent.click(await screen.findByRole("button", { name: "Edit Billing" }));
    expect((screen.getByLabelText(/New password/) as HTMLInputElement).value).toBe(""); expect((screen.getByLabelText("2FA secret (optional)") as HTMLInputElement).value).toBe("");
    change("Name", "Renamed"); fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await screen.findByRole("heading", { name: "Renamed" });
    expect(body(`/api/logins/${loginId}`, "PUT")).toEqual({ name: "Renamed", sites: savedLogin.sites, username: savedLogin.username });
  });

  it("replaces the password and supports an otpauth URI", async () => {
    mount(`/agents/${agentId}/logins`); fireEvent.click(await screen.findByRole("button", { name: "Edit Billing" }));
    change(/New password/, "replacement"); change("2FA secret (optional)", "otpauth://totp/QuokkaBot:owner?secret=JBSWY3DPEHPK3PXP&issuer=QuokkaBot");
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(body(`/api/logins/${loginId}`, "PUT")).toMatchObject({ password: "replacement", totp: "otpauth://totp/QuokkaBot:owner?secret=JBSWY3DPEHPK3PXP&issuer=QuokkaBot" }));
  });

  it("removes 2FA only when explicitly selected", async () => {
    mount(`/agents/${agentId}/logins`); fireEvent.click(await screen.findByRole("button", { name: "Edit Billing" }));
    change("2FA secret (optional)", "discarded replacement");
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove saved 2FA" })); fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(body(`/api/logins/${loginId}`, "PUT").totp).toBeNull());
  });

  it.each([["exa mple.com", "", /Invalid site/], ["example.com", "1234567890123456", /2FA must be/]])("validates sites and 2FA before writing: %s", async (site, totp, error) => {
    mount(`/agents/${agentId}/logins`); fireEvent.click(await screen.findByRole("button", { name: "Add login" }));
    change("Name", "Bad"); change("Sites", site); change("Username", "owner"); change("Password", "password"); if (totp) change("2FA secret (optional)", totp);
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(error);
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/logins") && init?.method === "POST")).toBe(false);
  });

  it("reads a pasted address as its site and shows saved sites without the wildcard", async () => {
    logins = [{ ...savedLogin, sites: ["*.example.com"] }];
    mount(`/agents/${agentId}/logins`); await screen.findByText("example.com");
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    change("Name", "Roblox"); change("Sites", "https://www.roblox.com/login?ref=home"); change("Username", "owner"); change("Password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(body(`/api/agents/${agentId}/logins`)).toMatchObject({ sites: ["www.roblox.com"] }));
  });

  it("allows a saved login on another site with one click", async () => {
    const otherSite = { ...linkRequest, site: "live.com", loginId: savedLogin.id, text: "Outlook signs in on live.com.\nThe site said: wrong site" };
    let allowed = false;
    handler = (url, init) => {
      if (url === `/api/agents/${agentId}/logins` && init?.method === "GET") return json({ logins: [savedLogin] });
      if (url === `/api/logins/${savedLogin.id}` && init?.method === "PUT") { allowed = true; return json(savedLogin); }
      if (url === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: allowed ? [] : [otherSite] });
      return undefined;
    };
    mount("/");
    const title = await screen.findByText("Use the Billing login on live.com");
    const card = title.closest("article"); if (!card) throw new Error("No allow card");
    expect(within(card).getByText("Saved for billing.example.com")).toBeTruthy();
    expect(within(card).queryByLabelText(/New password/)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(screen.queryByText("Use the Billing login on live.com")).toBeNull());
    expect(body(`/api/logins/${savedLogin.id}`, "PUT")).toEqual({ sites: ["billing.example.com", "live.com"] });
  });

  it("confirms deletion and removes the login only after the server responds", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount(`/agents/${agentId}/logins`); fireEvent.click(await screen.findByRole("button", { name: "Delete Billing" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete Billing" }));
    await screen.findByText("No saved logins."); expect(confirm).toHaveBeenCalledWith("Delete login “Billing”?");
  });

  it.each(["/", `/tasks/${taskId}`])("saves an inline login request and removes its card at %s", async path => {
    let answered = false;
    handler = (url, init) => {
      if (url === `/api/agents/${agentId}/logins` && init?.method === "POST") { answered = true; return json(savedLogin); }
      if (url === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: answered ? [] : [linkRequest] });
      return undefined;
    };
    mount(path); const title = await screen.findByText("Sign in to billing.example.com");
    const card = title.closest("article"); if (!card) throw new Error("No login request card");
    expect(within(card).getByText(linkRequest.text)).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open" }));
    // The card asks only for what the owner types; the site and name come from the request.
    expect(screen.queryByLabelText("Sites")).toBeNull(); expect(screen.getByText(/For billing\.example\.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "change" }));
    expect((screen.getByLabelText("Sites") as HTMLInputElement).value).toBe("billing.example.com"); expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Billing");
    change("Email or username", "owner"); change("Password", "secret"); fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(screen.queryByText("Sign in to billing.example.com")).toBeNull());
    expect(body(`/api/agents/${agentId}/logins`)).toEqual({ name: "Billing", sites: ["billing.example.com"], username: "owner", password: "secret" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reply") || String(url).endsWith("/takeover-done"))).toBe(false);
  });

  it("edits the rejected saved login in place and resumes through the update", async () => {
    const repair = { ...linkRequest, loginId: savedLogin.id, text: "The saved password was rejected.\nThe site said: Incorrect password" };
    let fixed = false;
    handler = (url, init) => {
      if (url === `/api/agents/${agentId}/logins` && init?.method === "GET") return json({ logins: [savedLogin] });
      if (url === `/api/logins/${savedLogin.id}` && init?.method === "PUT") { fixed = true; return json(savedLogin); }
      if (url === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: fixed ? [] : [repair] });
      return undefined;
    };
    mount("/");
    await screen.findByText("Fix the Billing login");
    expect(screen.getByText(/The saved password was rejected/).textContent).toBe(repair.text);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByLabelText(/New password/)).toBeTruthy();
    change(/New password/, "fixed-secret"); fireEvent.click(screen.getByRole("button", { name: "Save login" }));
    await waitFor(() => expect(screen.queryByText("Fix the Billing login")).toBeNull());
    expect(body(`/api/logins/${savedLogin.id}`, "PUT")).toMatchObject({ password: "fixed-secret" });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === `/api/agents/${agentId}/logins` && init?.method === "POST")).toBe(false);
  });

  it("turns a login request into a takeover when the owner signs in themselves", async () => {
    handler = (url, init) => {
      if (url === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: [linkRequest] });
      if (url === `/api/owner-requests/${linkRequest.id}/sign-in-myself` && init?.method === "POST") return json({});
      if (url === `/api/agents/${agentId}/takeover` && init?.method === "POST") return json({ holder: "owner", generation: 2, expiresAt: null });
      return undefined;
    };
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in myself instead" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/agents/${agentId}/takeover`)).toBe(true));
    expect(fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith("/sign-in-myself")))
      .toBeLessThan(fetchMock.mock.calls.findIndex(([url]) => String(url) === `/api/agents/${agentId}/takeover`));
    expect(body(`/api/owner-requests/${linkRequest.id}/sign-in-myself`)).toEqual({});
    expect(body(`/api/agents/${agentId}/takeover`)).toEqual({ action: "take" });
    expect(await screen.findByRole("heading", { name: "Computer" })).toBeTruthy();
  });
});
