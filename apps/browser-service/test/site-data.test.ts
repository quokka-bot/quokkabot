import { afterEach, describe, expect, it } from "vitest";
import { SiteDataClearResult } from "@quokkabot/shared";
import { harness } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
async function setup() { const h = await harness(); instances.push(h); return h; }
afterEach(async () => { for (const h of instances.splice(0)) await h.cleanup(); });

function cookie(domain: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "session", value: `secret-${domain}`, domain, path: "/", session: false, expires: 1_900_000_000,
    secure: true, httpOnly: true, sameSite: "Lax", priority: "High", sourceScheme: "Secure", sourcePort: 443, ...overrides };
}

describe("attended site-data clearing", () => {
  it("deletes matching domain and subdomain cookies, preserves other cookies, and clears both schemes", async () => {
    const h = await setup();
    const unrelated = cookie("unrelated.example.org", { partitionKey: { topLevelSite: "https://example.org", hasCrossSiteAncestor: true } });
    const session = cookie("other.example.org", { session: true, expires: -1, secure: false, httpOnly: false });
    const lookalike = cookie("notexample.com");
    h.cdp.cookies = [cookie(".example.com"), cookie("billing.example.com"), cookie(".deep.billing.example.com"), unrelated, session, lookalike];
    h.cdp.targets = [
      { type: "page", url: "https://example.com/dashboard" },
      { type: "page", url: "http://portal.example.com/login" },
      { type: "page", url: "https://portal.example.com/another" },
      { type: "page", url: "https://port.example.com:8443/path" },
      { type: "page", url: "https://unrelated.example.org/" },
      { type: "page", url: "about:blank" },
      { type: "service_worker", url: "https://worker.example.com/script.js" },
    ];
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const response = await h.request("POST", "/v1/site-data/clear", { patterns: ["*.example.com", "billing.example.com"] });
    expect(response.statusCode).toBe(200);
    const result = SiteDataClearResult.parse(response.body);
    expect(result.cookiesDeleted).toBe(3);
    const hosts = ["example.com", "billing.example.com", "deep.billing.example.com", "portal.example.com", "port.example.com:8443"];
    expect(result.originsCleared).toEqual(hosts.flatMap((host) => [`http://${host}`, `https://${host}`]).sort());
    expect(h.cdp.cookies).toEqual([unrelated, session, lookalike]);
    expect(h.cdp.calls.filter((call) => call.method === "Storage.clearDataForOrigin")).toEqual(
      result.originsCleared.map((origin) => ({ method: "Storage.clearDataForOrigin", params: { origin, storageTypes: "all" } })),
    );
    expect(h.cdp.calls.filter((call) => call.method.startsWith("Storage.")).every((call) => call.sessionId === undefined)).toBe(true);
    const restored = h.cdp.calls.find((call) => call.method === "Storage.setCookies")?.params.cookies as Record<string, unknown>[];
    expect(restored[0]).toMatchObject({ partitionKey: unrelated.partitionKey, priority: "High", expires: unrelated.expires });
    expect(restored[1]).not.toHaveProperty("expires");
    expect(restored.every((entry) => !Object.hasOwn(entry, "session"))).toBe(true);
    expect(await h.command({ op: "click", tab: "t1", snapshot: snapshot.snapshot, ref: "e1" })).toMatchObject({ status: "invalid" });
  });

  it("uses exact host patterns without deleting subdomains or unrelated cookie jars", async () => {
    const h = await setup();
    h.cdp.cookies = [cookie("example.com"), cookie("sub.example.com")];
    const response = await h.request("POST", "/v1/site-data/clear", { patterns: ["EXAMPLE.COM."] });
    expect(response).toMatchObject({ statusCode: 200, body: { cookiesDeleted: 1, originsCleared: ["http://example.com", "https://example.com"] } });
    expect(h.cdp.cookies.map((entry) => entry.domain)).toEqual(["sub.example.com"]);
  });

  it("clears open-tab storage with no matching cookies and avoids rewriting unrelated cookies", async () => {
    const h = await setup();
    const kept = cookie("other.example.org");
    h.cdp.cookies = [kept];
    h.cdp.targets = [{ type: "page", url: "http://app.example.com/" }];
    expect(await h.request("POST", "/v1/site-data/clear", { patterns: ["*.example.com"] })).toMatchObject({
      statusCode: 200, body: { cookiesDeleted: 0, originsCleared: ["http://app.example.com", "https://app.example.com"] },
    });
    expect(h.cdp.cookies).toEqual([kept]);
    expect(h.cdp.calls.some((call) => ["Storage.clearCookies", "Storage.setCookies"].includes(call.method))).toBe(false);
  });

  it.each(["Storage.getCookies", "Target.getTargets", "Storage.clearCookies", "Storage.setCookies", "Storage.clearDataForOrigin"])("returns 500 when %s fails", async (method) => {
    const h = await setup();
    h.cdp.cookies = [cookie("example.com"), cookie("other.example.org")];
    h.cdp.failMethod = method;
    const response = await h.request("POST", "/v1/site-data/clear", { patterns: ["*.example.com"] });
    expect(response).toEqual({ statusCode: 500, body: { message: `site-data clear failed during ${method}` } });
    expect(response.body).not.toHaveProperty("cookiesDeleted");
    h.cdp.failMethod = undefined;
    expect((await h.command({ op: "tabs" })).status).toBe("ok");
  });

  it("reports a failure after a partially cleared set of origins", async () => {
    const h = await setup();
    h.cdp.onSend = (method) => {
      if (method === "Storage.clearDataForOrigin" && h.cdp.calls.filter((call) => call.method === method).length === 2) {
        throw new Error("second origin failed");
      }
    };
    expect((await h.request("POST", "/v1/site-data/clear", { patterns: ["*.example.com"] })).statusCode).toBe(500);
  });

  it("refuses to overwrite cookies with an opaque partition key that CDP cannot restore", async () => {
    const h = await setup();
    h.cdp.cookies = [cookie("example.com"), cookie("other.example.org", { partitionKeyOpaque: true })];
    expect((await h.request("POST", "/v1/site-data/clear", { patterns: ["*.example.com"] })).statusCode).toBe(500);
    expect(h.cdp.cookies).toHaveLength(2);
    expect(h.cdp.calls.some((call) => call.method === "Storage.clearCookies")).toBe(false);
  });

  it.each([{ origins: ["https://example.com"] }, { patterns: [] }, { patterns: ["https://example.com"] }, { patterns: ["*.example.com"], extra: true }])("validates the shared request contract: %j", async (body) => {
    const h = await setup();
    expect((await h.request("POST", "/v1/site-data/clear", body)).statusCode).toBe(400);
    expect(h.cdp.calls.some((call) => call.method.startsWith("Storage."))).toBe(false);
  });
});
