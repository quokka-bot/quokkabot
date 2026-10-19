import { describe, expect, it } from "vitest";
import { LoginView } from "@quokkabot/shared";
import { listSites, loginRequestOptions, loginSites, validateTotp } from "../src/index.js";
import { agentId, at, ownerRequest } from "./fixtures.js";

describe("card helpers", () => {
  const login = LoginView.parse({ id: "77777777-7777-4777-8777-777777777777", agentId, name: "Billing", sites: ["example.com"], username: "owner", passwordLength: 12, hasTotp: false, createdAt: at, updatedAt: at, lastUsedAt: null });

  it("lists zero, one, two and many sites using their display labels", () => {
    expect(listSites([])).toBe("");
    expect(listSites(["*.example.com"])).toBe("example.com");
    expect(listSites(["*.example.com", "billing.example.org"])).toBe("example.com and billing.example.org");
    expect(listSites(["example.com", "example.org", "example.net"])).toBe("example.com, example.org and example.net");
  });

  it("offers the saved-login action only when the requested site is not covered", () => {
    const request = { ...ownerRequest, kind: "login" as const, site: "accounts.example.org", loginId: login.id, loginName: login.name };
    expect(loginRequestOptions(request, login)).toEqual({ title: "Fix the Billing login", otherSite: true, google: false });
    expect(loginRequestOptions({ ...request, site: "example.com" }, login).otherSite).toBe(false);
    expect(loginRequestOptions({ ...request, site: "billing.example.com" }, login).otherSite).toBe(true);
    expect(loginRequestOptions({ ...request, site: "billing.example.com" }, { ...login, sites: ["*.example.com"] }).otherSite).toBe(false);
    expect(loginRequestOptions({ ...request, site: null }, login).otherSite).toBe(false);
    expect(loginRequestOptions(request, undefined).otherSite).toBe(false);
    expect(loginRequestOptions({ ...ownerRequest, kind: "login", site: "example.com" }, undefined).title).toBe("Sign in to example.com");
    expect(loginRequestOptions({ ...ownerRequest, kind: "login" }, undefined).title).toBe("Sign in to a site");
  });

  it.each([
    ["gmail.com", "Sign in", true],
    ["mail.google.com", "Sign in", true],
    ["accounts.google.com", "Read the inbox", true],
    ["accounts.google.com", "Open Drive", false],
    ["example.com", "Use Sign in with Google", false],
    ["gmail.com.example.org", "Read email", false],
  ])("offers Gmail connection for %s and %s: %s", (site, text, expected) => {
    expect(loginRequestOptions({ ...ownerRequest, kind: "login", site, text }, undefined).google).toBe(expected);
  });

  it("uses the saved login name as context for a Google sign-in", () => {
    expect(loginRequestOptions({ ...ownerRequest, site: "accounts.google.com", loginName: "Gmail", text: "Sign in" }, undefined).google).toBe(true);
  });
});

describe("login form validation", () => {
  it("normalizes pasted URLs and comma-separated sites", () => {
    expect(loginSites(" https://www.example.com/login , *.EXAMPLE.ORG ")).toEqual(["www.example.com", "*.example.org"]);
  });

  it.each(["", "example.com,", "https://", "https://localhost/login", "../example.com"])("rejects invalid site lists: %j", sites => {
    expect(() => loginSites(sites)).toThrow("Invalid site:");
  });

  it("preserves valid grouped secrets and authenticator URIs after trimming", () => {
    expect(validateTotp("  jbsw y3dp-ehpk 3pxp  ")).toBe("jbsw y3dp-ehpk 3pxp");
    const uri = "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP";
    expect(validateTotp(` ${uri} `)).toBe(uri);
  });

  it.each(["short", "JBSWY3DPEHPK3PX0", "otpauth://hotp/Example?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/Example?secret=short"])("rejects invalid 2FA values: %s", value => {
    expect(() => validateTotp(value)).toThrow("2FA must be a base32 secret");
  });
});
