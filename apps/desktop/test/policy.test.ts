import { describe, expect, it } from "vitest";
import { checkDesktopInfo, partitionForOrigin, validateOrigin, validateServerPair } from "../src/origins.js";
import { isExternalHttps, navigationDecision, permissionAllowed, routeAllowed, senderAllowed } from "../src/policy.js";
import { DownloadTarget, NoPayload, SettingsPatch } from "../src/schemas.js";
import { updateFeed, validateUpdateFiles } from "../src/update-policy.js";

const origins = { serverOrigin: "https://app.example.com", viewOrigin: "https://view.example.com" };

describe("server origins", () => {
  it("canonicalises HTTPS and allows HTTP only under .localhost", () => {
    expect(validateOrigin("https://APP.example.com:443/")).toBe(origins.serverOrigin);
    expect(validateOrigin("http://app.quokkabot.localhost:3000")).toBe("http://app.quokkabot.localhost:3000");
    for (const value of ["http://app.example.com", "http://localhost", "http://127.0.0.1", "file:///app", "javascript:alert(1)", "https://user:pass@app.example.com", "https://app.example.com/tasks", "https://app.example.com/..", "https://app.example.com/%2e", "https://app.example.com?", "https://app.example.com#", " https://app.example.com", "https://app.example.com\\"]) {
      expect(() => validateOrigin(value), value).toThrow();
    }
  });
  it("checks schemeful sites using ICANN, private, wildcard and exception rules", () => {
    expect(validateServerPair(origins.serverOrigin, origins.viewOrigin)).toEqual(origins);
    expect(() => validateServerPair("https://app.example.co.uk", "https://view.example.co.uk")).not.toThrow();
    expect(() => validateServerPair("https://quokkabot.github.io", "https://view.quokkabot.github.io")).not.toThrow();
    expect(() => validateServerPair("https://app.city.kawasaki.jp", "https://view.city.kawasaki.jp")).not.toThrow();
    expect(() => validateServerPair("http://app.quokkabot.localhost", "http://view.quokkabot.localhost")).not.toThrow();
    expect(() => validateServerPair("https://app.example.com", "https://app.example.com:8443")).not.toThrow();
    expect(() => validateServerPair("https://127.0.0.1", "https://127.0.0.1:8443")).not.toThrow();
    for (const pair of [
      [origins.serverOrigin, origins.serverOrigin], [origins.serverOrigin, "https://evil.example.net"],
      ["https://app.co.uk", "https://view.co.uk"], ["https://first.github.io", "https://second.github.io"],
      ["https://first.vercel.app", "https://second.vercel.app"], ["https://first.s3.amazonaws.com", "https://second.s3.amazonaws.com"],
      ["https://first.foo.kawasaki.jp", "https://second.bar.kawasaki.jp"], ["https://app.quokkabot.localhost", "http://view.quokkabot.localhost"],
    ]) {
      const [app, view] = pair;
      if (app === undefined || view === undefined) throw new Error("Invalid test pair.");
      expect(() => validateServerPair(app, view), pair.join(", ")).toThrow();
    }
  });
  it("binds desktop info and minimum version to the entered origin", () => {
    const info = { product: "quokkabot", apiVersion: 1, appOrigin: origins.serverOrigin, viewOrigin: origins.viewOrigin, desktopDownloads: true, minDesktopVersion: "0.1.0" };
    expect(checkDesktopInfo(info, origins.serverOrigin, "0.1.0")).toEqual(info);
    expect(checkDesktopInfo({ ...info, viewOrigin: `${info.viewOrigin}/` }, origins.serverOrigin, "0.1.0").viewOrigin).toBe(info.viewOrigin);
    expect(() => checkDesktopInfo(info, "https://other.example.com", "0.1.0")).toThrow(/appOrigin/u);
    expect(() => checkDesktopInfo({ ...info, minDesktopVersion: "1.0.0" }, origins.serverOrigin, "0.1.0")).toThrow(/requires/u);
    expect(() => checkDesktopInfo({ ...info, product: "other" }, origins.serverOrigin, "0.1.0")).toThrow();
    expect(partitionForOrigin(origins.serverOrigin)).toMatch(/^persist:quokkabot-[0-9a-f]{16}$/u);
    expect(partitionForOrigin(`${origins.serverOrigin}/`)).toBe(partitionForOrigin(origins.serverOrigin));
    expect(partitionForOrigin(origins.viewOrigin)).not.toBe(partitionForOrigin(origins.serverOrigin));
  });
});

describe("navigation, permissions and IPC authority", () => {
  it("only embeds app pages in the main frame, and app or viewer pages in child frames", () => {
    expect(navigationDecision(`${origins.serverOrigin}/tasks/1`, true, origins)).toBe("allow");
    expect(navigationDecision(origins.viewOrigin, false, origins)).toBe("allow");
    expect(navigationDecision(origins.viewOrigin, true, origins)).toBe("external");
    expect(navigationDecision("https://example.net", true, origins)).toBe("external");
    expect(navigationDecision("https://example.net", false, origins)).toBe("block");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "http://example.com", "https://user:pass@app.example.com"]) {
      expect(navigationDecision(url, true, origins)).toBe("block");
      expect(isExternalHttps(url)).toBe(false);
    }
  });
  it("permits only the required origin-scoped permissions", () => {
    expect(permissionAllowed("notifications", origins.serverOrigin, origins)).toBe(true);
    expect(permissionAllowed("notifications", origins.viewOrigin, origins)).toBe(false);
    for (const permission of ["fullscreen", "pointerLock", "keyboardLock"]) {
      expect(permissionAllowed(permission, origins.viewOrigin, origins)).toBe(true);
      expect(permissionAllowed(permission, origins.serverOrigin, origins)).toBe(false);
    }
    for (const permission of ["media", "clipboard-read", "fileSystem", "geolocation", "openExternal", "usb", "unknown"]) expect(permissionAllowed(permission, origins.serverOrigin, origins)).toBe(false);
  });
  it("requires the main window's main frame at the app origin", () => {
    const sender = { senderId: 1, mainWindowId: 1, isMainFrame: true, url: `${origins.serverOrigin}/` };
    expect(senderAllowed(sender, origins.serverOrigin)).toBe(true);
    for (const patch of [{ senderId: 2 }, { mainWindowId: null }, { isMainFrame: false }, { url: origins.viewOrigin }, { url: "file:///connect.html" }]) expect(senderAllowed({ ...sender, ...patch }, origins.serverOrigin)).toBe(false);
    expect(routeAllowed("/?new=1")).toBe(true);
    expect(routeAllowed("//example.com")).toBe(false);
  });
  it("validates closed payloads and refuses traversal and mixed download targets", () => {
    const id = "d1e742f7-406f-4e68-a596-a8e97801e24e";
    expect(DownloadTarget.parse({ fileId: id })).toEqual({ fileId: id });
    expect(DownloadTarget.parse({ agentId: id, path: "invoices/october.pdf" })).toEqual({ agentId: id, path: "invoices/october.pdf" });
    for (const input of [{ fileId: id, url: "https://evil.example" }, { fileId: id, agentId: id, path: "a" }, { agentId: id, path: "../secret" }, { agentId: id, path: "/etc/passwd" }, { agentId: id, path: "." }]) expect(DownloadTarget.safeParse(input).success).toBe(false);
    expect(SettingsPatch.parse({ notifications: false })).toEqual({ notifications: false });
    expect(SettingsPatch.safeParse({ serverOrigin: "https://evil.example" }).success).toBe(false);
    expect(SettingsPatch.safeParse({ notifications: "yes" }).success).toBe(false);
    expect(NoPayload.safeParse({}).success).toBe(false);
  });
  it("restricts update artifacts to the configured feed", () => {
    expect(updateFeed(origins.serverOrigin)).toBe(`${origins.serverOrigin}/desktop/`);
    expect(() => validateUpdateFiles({ files: [{ url: "QuokkaBot.zip" }] }, origins.serverOrigin)).not.toThrow();
    for (const url of ["https://evil.example/desktop/app.zip", "../app.zip", "file:///app.zip", "https://user:pass@app.example.com/desktop/app.zip"]) expect(() => validateUpdateFiles({ files: [{ url }] }, origins.serverOrigin)).toThrow();
  });
});
