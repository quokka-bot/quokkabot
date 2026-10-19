import { describe, expect, it } from "vitest";
import { hostMatchesPattern, siteLabel } from "../src/egress.js";
import { registrableDomain, sitePattern, sitePatterns } from "../src/sites.js";

describe("sites", () => {
  it("finds the registrable domain with ICANN and private suffixes", () => {
    expect(registrableDomain("auth.roblox.com")).toBe("roblox.com");
    expect(registrableDomain("roblox.com")).toBe("roblox.com");
    expect(registrableDomain("WWW.BBC.CO.UK.")).toBe("bbc.co.uk");
    expect(registrableDomain("docs.owner.github.io")).toBe("owner.github.io");
    expect(registrableDomain("city.kawasaki.jp")).toBe("city.kawasaki.jp");
    expect(registrableDomain("github.io")).toBeNull();
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("10.0.0.1")).toBeNull();
    expect(registrableDomain("::1")).toBeNull();
  });

  it("turns the hosts a sign-in needs into one rule per site", () => {
    const hosts = [
      "www.roblox.com", "roblox.com", "auth.roblox.com", "apis.roblox.com", "create.roblox.com", "users.roblox.com",
      "games.roblox.com", "economy.roblox.com", "twostepverification.roblox.com", "css.rbxcdn.com", "js.rbxcdn.com",
      "images.rbxcdn.com", "tr.rbxcdn.com", "static.rbxcdn.com", "roblox-api.arkoselabs.com", "client-api.arkoselabs.com",
    ];
    const rules = sitePatterns(hosts);
    expect(rules).toEqual(["*.roblox.com", "*.rbxcdn.com", "*.arkoselabs.com"]);
    expect(rules.map(siteLabel)).toEqual(["roblox.com", "rbxcdn.com", "arkoselabs.com"]);
    for (const host of hosts) expect(rules.some(rule => hostMatchesPattern(host, rule))).toBe(true);
    expect(rules.some(rule => hostMatchesPattern("roblox.com.evil.example", rule))).toBe(false);
  });

  it("never widens a rule past one site", () => {
    expect(sitePattern("*.docs.owner.github.io")).toBe("*.owner.github.io");
    expect(hostMatchesPattern("other.github.io", sitePattern("owner.github.io"))).toBe(false);
    // A host that is itself a public suffix stays exact; a wildcard over one is refused.
    expect(sitePattern("github.io")).toBe("github.io");
    expect(() => sitePattern("*.github.io")).toThrow("covers every site under a public suffix");
    expect(() => sitePattern("*.co.uk")).toThrow("covers every site under a public suffix");
  });
});
