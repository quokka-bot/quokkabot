import { _electron as electron, expect, test } from "playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const server = process.env["QUOKKABOT_E2E_SERVER"];
if (!server) throw new Error("QUOKKABOT_E2E_SERVER is required.");
let application: ElectronApplication;
let userData: string;
let connect: Page;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "quokkabot-electron-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env["ELECTRON_RUN_AS_NODE"];
  application = await electron.launch({ args: [root], env: { ...env, QUOKKABOT_E2E_USER_DATA: userData } });
  connect = await application.firstWindow();
  await expect(connect.getByRole("heading", { name: "Your agents, on your server." })).toBeVisible();
});
test.afterEach(async () => {
  try { if (application) await application.close(); }
  finally { if (userData) await rm(userData, { recursive: true, force: true }); }
});

async function connectServer(): Promise<Page> {
  await connect.getByLabel("Server address").fill(server as string);
  const window = application.waitForEvent("window");
  await connect.getByRole("button", { name: "Connect", exact: true }).click();
  const main = await window;
  await expect(main.getByRole("heading", { name: "Sign in to Quokka Bot" })).toBeVisible();
  return main;
}

test("first launch uses only the minimal connect bridge", async () => {
  expect(await connect.evaluate(() => "quokkabotDesktop" in window)).toBe(false);
  expect(await connect.evaluate(() => Object.keys((window as unknown as { quokkabotConnect: object }).quokkabotConnect).sort())).toEqual(["connect", "getVersion"]);
});
test("an invalid URL is refused without opening the app window", async () => {
  await connect.getByLabel("Server address").fill("http://example.com");
  await connect.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connect.getByRole("alert")).toContainText("Use HTTPS");
  expect(application.windows()).toHaveLength(1);
});
test("a validated server opens the sign-in screen with a restricted desktop bridge", async () => {
  const main = await connectServer();
  expect(new URL(main.url()).origin).toBe(new URL(server as string).origin);
  expect(await main.evaluate(() => "quokkabotDesktop" in window)).toBe(true);
  expect(await main.evaluate(() => "require" in window)).toBe(false);
  expect(await main.evaluate(() => "quokkabotConnect" in window)).toBe(false);
});
test("cross-origin navigation is blocked and HTTPS window.open is sent to the default browser", async () => {
  const main = await connectServer();
  const original = main.url();
  await main.evaluate(() => { window.location.href = "https://external.example/navigation"; });
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { __quokkabotE2E: { openedExternal: string[] } }).__quokkabotE2E.openedExternal)).toContain("https://external.example/navigation");
  expect(main.url()).toBe(original);
  await main.evaluate(() => { window.open("https://external.example/popup", "_blank"); window.open("file:///etc/passwd", "_blank"); });
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { __quokkabotE2E: { openedExternal: string[] } }).__quokkabotE2E.openedExternal)).toContain("https://external.example/popup");
  expect(application.windows()).toHaveLength(1);
});
test("closing the main window destroys its renderer and leaves main and the tray running", async () => {
  const main = await connectServer();
  await main.close();
  await expect.poll(() => application.windows().length).toBe(0);
  expect(application.process().exitCode).toBeNull();
  expect(await application.evaluate(() => (globalThis as unknown as { __quokkabotE2E: { hasTray: () => boolean } }).__quokkabotE2E.hasTray())).toBe(true);
});
