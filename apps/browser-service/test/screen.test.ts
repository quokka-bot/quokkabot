import { afterEach, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
async function setup(options?: Parameters<typeof harness>[0]) { const h = await harness(options); instances.push(h); return h; }
afterEach(async () => { for (const h of instances.splice(0)) await h.cleanup(); });
const phone = { width: 504, height: 846 };
const screen = (h: Harness, body: unknown) => h.request("PUT", "/v1/screen", body);

describe("the computer's screen", () => {
  it("sets the desktop size before Chrome starts", async () => {
    const h = await setup();
    expect(h.resizes[0]).toBe("1280x800");
    expect(h.starts).toHaveLength(1);
    expect((await h.request("GET", "/v1/screen")).body).toEqual({ width: 1280, height: 800 });
  });

  it("lets only the owner's current, unexpired lease fit the screen", async () => {
    const h = await setup();
    expect(await screen(h, { ...phone, leaseGeneration: 2 })).toMatchObject({ statusCode: 409, body: { message: "no takeover" } });
    await h.service.setControlLease({ holder: "paused", generation: 3, expiresAt: null });
    expect((await screen(h, { ...phone, leaseGeneration: 3 })).statusCode).toBe(409);
    await h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect((await screen(h, { ...phone, leaseGeneration: 4 })).statusCode).toBe(409);
    await h.service.setControlLease({ holder: "owner", generation: 5, expiresAt: null });
    expect((await screen(h, { ...phone, leaseGeneration: 4 })).statusCode).toBe(409);
    expect(h.resizes).toEqual(["1280x800"]);
    expect(await screen(h, { ...phone, leaseGeneration: 5 })).toMatchObject({ statusCode: 200, body: phone });
    expect(h.resizes).toEqual(["1280x800", "504x846"]);
    expect((await h.request("GET", "/v1/screen")).body).toEqual(phone);
  });

  it.each([
    { width: 505, height: 660 }, { width: 496, height: 660 }, { width: 1928, height: 660 },
    { width: 504, height: 661 }, { width: 504, height: 238 }, { width: 504, height: 1922 },
  ])("refuses a screen of $width x $height", async (size) => {
    const h = await setup();
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    expect((await screen(h, { ...size, leaseGeneration: 3 })).statusCode).toBe(400);
    expect((await screen(h, { ...phone, leaseGeneration: 3, dpi: 288 })).statusCode).toBe(400);
    expect(h.resizes).toEqual(["1280x800"]);
  });

  it("puts the desktop size back on every lease that leaves the owner, and keeps the phone's on a new owner lease", async () => {
    const h = await setup();
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    await screen(h, { ...phone, leaseGeneration: 3 });
    await h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: null });
    expect((await h.request("GET", "/v1/screen")).body).toEqual(phone);
    await h.service.setControlLease({ holder: "paused", generation: 5, expiresAt: null });
    expect((await h.request("GET", "/v1/screen")).body).toEqual({ width: 1280, height: 800 });
    await h.service.setControlLease({ holder: "owner", generation: 6, expiresAt: null });
    await screen(h, { ...phone, leaseGeneration: 6 });
    await h.service.setControlLease({ holder: "agent", generation: 7, expiresAt: null });
    expect(h.resizes).toEqual(["1280x800", "504x846", "1280x800", "504x846", "1280x800"]);
    expect((await h.command({ op: "tabs" }, 7)).status).toBe("ok");
  });

  it("keeps the agent fenced while the desktop size is not back, and retries it", async () => {
    const h = await setup();
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    await screen(h, { ...phone, leaseGeneration: 3 });
    h.screen.fail = true;
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    expect(await h.command({ op: "tabs" }, 4)).toMatchObject({ status: "failed", message: "browser not ready" });
    expect((await h.request("GET", "/health")).body).toMatchObject({ agentBrowserReady: false });
    // A size the X server realizes differently is a failure too.
    h.screen.fail = false; h.screen.realized = "1288x800";
    expect((await h.command({ op: "tabs" }, 4)).status).toBe("failed");
    h.screen.realized = undefined;
    expect((await h.command({ op: "tabs" }, 4)).status).toBe("ok");
    expect((await h.request("GET", "/v1/screen")).body).toEqual({ width: 1280, height: 800 });
  });

  it("maximizes every Chrome window after a resize", async () => {
    const h = await setup();
    h.cdp.targets = ["example.com", "login.example.com", "popup.example.com", "video.example.com"].map((host) => ({ type: "page", url: `https://${host}/` }));
    h.cdp.windowStates = ["maximized", "normal", "minimized", "fullscreen"];
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    h.cdp.calls = [];
    await screen(h, { ...phone, leaseGeneration: 3 });
    expect(h.cdp.windowStates).toEqual(["maximized", "maximized", "maximized", "maximized"]);
    expect(h.cdp.calls.filter((call) => call.method === "Browser.setWindowBounds").map((call) => call.params)).toEqual([
      { windowId: 2, bounds: { windowState: "maximized" } },
      { windowId: 3, bounds: { windowState: "normal" } }, { windowId: 3, bounds: { windowState: "maximized" } },
      { windowId: 4, bounds: { windowState: "normal" } }, { windowId: 4, bounds: { windowState: "maximized" } },
    ]);
  });
});
