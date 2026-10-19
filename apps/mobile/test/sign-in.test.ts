import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "../src/api";
import { discover, pollLink, serverOrigin, signInWithCode, waitForLink } from "../src/sign-in";

const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const info = (appOrigin: string, phone = true) => ({
  product: "quokkabot", apiVersion: 1, appOrigin, viewOrigin: "https://view.example.com", desktopDownloads: false, minDesktopVersion: "0.1.0",
  ...(phone ? { phoneApi: 1 } : {}),
});

describe("server address", () => {
  it("takes a host, a URL or the QR code's link, and keeps only the origin", () => {
    expect(serverOrigin("quokkabot.example.com")).toBe("https://quokkabot.example.com");
    expect(serverOrigin("  https://quokkabot.example.com/settings?x=1  ")).toBe("https://quokkabot.example.com");
    expect(serverOrigin(`quokkabot://connect?server=${encodeURIComponent("https://bot.example.org")}`)).toBe("https://bot.example.org");
    expect(serverOrigin(`quokkabot-dev://connect?server=${encodeURIComponent("https://bot.example.org:8443")}`)).toBe("https://bot.example.org:8443");
  });

  it("refuses plain http except the *.localhost development server, and user names in the address", () => {
    expect(() => serverOrigin("http://quokkabot.example.com")).toThrow("https");
    expect(serverOrigin("http://quokkabot.localhost:8080")).toBe("http://quokkabot.localhost:8080");
    expect(() => serverOrigin("https://owner:secret@quokkabot.example.com")).toThrow("user name");
    expect(() => serverOrigin("ftp://quokkabot.example.com")).toThrow("https");
  });
});

describe("discovery", () => {
  it("accepts a Quokka Bot server at the address it reports, with the phone API", async () => {
    const fetchImpl: Fetch = vi.fn(async () => json(200, info("https://bot.example.com")));
    await expect(discover(fetchImpl, "https://bot.example.com")).resolves.toEqual({ origin: "https://bot.example.com", viewOrigin: "https://view.example.com" });
    expect(fetchImpl).toHaveBeenCalledWith("https://bot.example.com/api/desktop/info", expect.objectContaining({ method: "GET" }));
  });

  it("refuses a server that reports another address, an older server, and a site that is not Quokka Bot", async () => {
    await expect(discover(async () => json(200, info("https://other.example.com")), "https://bot.example.com")).rejects.toThrow("https://other.example.com");
    await expect(discover(async () => json(200, info("https://bot.example.com", false)), "https://bot.example.com")).rejects.toThrow("too old");
    await expect(discover(async () => json(404, { error: { code: "not_found", message: "No" } }), "https://bot.example.com")).rejects.toThrow("not a Quokka Bot server");
  });
});

describe("sign-in requests", () => {
  it("sends a code without a session and keeps the token the server returns", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => json(200, { token: "t".repeat(43) }));
    const server = { origin: "https://bot.example.com", viewOrigin: "https://view.example.com" };
    await expect(signInWithCode(fetchImpl, server, "abcd-efgh-jkmn", "Owner's iPhone")).resolves.toEqual({ ...server, token: "t".repeat(43) });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://bot.example.com/api/phone/code");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body!)).toEqual({ code: "ABCDEFGHJKMN", deviceName: "Owner's iPhone" });
  });

  it("reads a link's state from 202 and 410, the token from 200, and fails on anything else", async () => {
    await expect(pollLink(async () => json(202, { state: "pending" }), "https://bot.example.com", "p".repeat(43))).resolves.toEqual({ state: "pending" });
    await expect(pollLink(async () => json(410, { state: "refused" }), "https://bot.example.com", "p".repeat(43))).resolves.toEqual({ state: "refused" });
    await expect(pollLink(async () => json(200, { state: "approved", token: "t".repeat(43) }), "https://bot.example.com", "p".repeat(43))).resolves.toEqual({ token: "t".repeat(43) });
    await expect(pollLink(async () => json(500, {}), "https://bot.example.com", "p".repeat(43))).rejects.toThrow("HTTP 500");
  });

  it("polls until the link is decided, and stops when told to", async () => {
    const answers = [json(202, { state: "pending" }), json(202, { state: "pending" }), json(200, { state: "approved", token: "t".repeat(43) })];
    const sleep = vi.fn(async () => undefined);
    await expect(waitForLink(async () => answers.shift()!, "https://bot.example.com", "p".repeat(43), () => false, sleep)).resolves.toEqual({ token: "t".repeat(43) });
    expect(sleep).toHaveBeenCalledTimes(2);
    let stop = false;
    const stopping = waitForLink(async () => { stop = true; return json(202, { state: "pending" }); }, "https://bot.example.com", "p".repeat(43), () => stop, sleep);
    await expect(stopping).resolves.toEqual({ state: "stopped" });
  });
});
