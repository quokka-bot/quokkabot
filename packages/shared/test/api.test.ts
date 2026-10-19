import { describe, expect, it } from "vitest";
import { AgentSummary, AuditVerification, EmptyResponse, FreshAuth, InboxResponse, SafeFileListing, TaskPage, WebAuthnAuthenticationOptions, WebAuthnRegistrationOptions } from "../src/api.js";

const oldSummary = {
  id: "11111111-1111-4111-8111-111111111111", name: "Office", model: "claude-opus-4-6", effort: "high", cliSignedIn: "no",
  computer: { state: "stopped", sandboxes: [], lease: { holder: "paused", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
  activeTaskId: null, waitingOnOwner: 0,
};
describe("agent occupant generation", () => {
  it("reads old payloads as generation 1 and preserves the current generation", () => {
    expect(AgentSummary.parse(oldSummary).generation).toBe(1);
    expect(AgentSummary.parse({ ...oldSummary, generation: 4 }).generation).toBe(4);
  });
  it.each([null, 0, -1, 1.5, "2"])("rejects invalid generations: %s", generation => {
    expect(AgentSummary.safeParse({ ...oldSummary, generation }).success).toBe(false);
  });
});

describe("owner API response schemas", () => {
  it("validates passkey options while preserving unknown options and extensions", () => {
    const authentication = { challenge: "challenge", allowCredentials: [{ id: "credential", type: "public-key", transports: ["hybrid"] }], extensions: { credProps: true, futureExtension: "value" }, futureOption: true };
    expect(WebAuthnAuthenticationOptions.parse(authentication)).toEqual(authentication);
    expect(WebAuthnAuthenticationOptions.safeParse({ challenge: "" }).success).toBe(false);
    expect(WebAuthnAuthenticationOptions.safeParse({ ...authentication, allowCredentials: [{ id: "credential", type: "password" }] }).success).toBe(false);
    const registration = { challenge: "challenge", rp: { name: "Quokka Bot" }, user: { id: "owner", name: "Owner", displayName: "Owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], extensions: { futureExtension: "value" }, futureOption: true };
    expect(WebAuthnRegistrationOptions.parse(registration)).toEqual(registration);
    expect(WebAuthnRegistrationOptions.safeParse({ ...registration, pubKeyCredParams: [] }).success).toBe(false);
  });

  it("accepts empty responses and fresh-auth timestamps with an offset", () => {
    expect(EmptyResponse.parse(null)).toBeNull();
    expect(EmptyResponse.parse({})).toEqual({});
    expect(EmptyResponse.safeParse({ unexpected: true }).success).toBe(false);
    expect(FreshAuth.parse({ freshUntil: "2026-10-17T11:00:00+03:00" }).freshUntil).toBe("2026-10-17T11:00:00+03:00");
    expect(FreshAuth.safeParse({ freshUntil: "tomorrow" }).success).toBe(false);
  });

  it("requires the matching audit verification result fields", () => {
    expect(AuditVerification.parse({ ok: true, count: 0, head: "a".repeat(64) }).ok).toBe(true);
    expect(AuditVerification.parse({ ok: false, count: 2, failedAtSeq: 3, reason: "Hash mismatch" }).ok).toBe(false);
    expect(AuditVerification.safeParse({ ok: true, count: 0, head: "invalid" }).success).toBe(false);
    expect(AuditVerification.safeParse({ ok: false, count: 2 }).success).toBe(false);
  });

  it("validates inbox and task pages", () => {
    expect(InboxResponse.parse({ items: [] })).toEqual({ items: [] });
    expect(InboxResponse.safeParse({ items: [{ kind: "unknown" }] }).success).toBe(false);
    expect(TaskPage.parse({ tasks: [], nextBefore: null })).toEqual({ tasks: [], nextBefore: null });
    expect(TaskPage.safeParse({ tasks: [{}], nextBefore: null }).success).toBe(false);
  });

  it("rejects file entries that leave the file root", () => {
    const listing = { scope: "workspace", dir: "", entries: [{ name: "invoice.txt", path: "reports/invoice.txt", type: "file", bytes: 1, modifiedAt: "2026-10-17T08:00:00.000Z", file: null }], nextCursor: null };
    expect(SafeFileListing.parse(listing)).toEqual(listing);
    for (const path of ["../invoice.txt", "/invoice.txt", "reports/../../invoice.txt"]) {
      const result = SafeFileListing.safeParse({ ...listing, entries: [{ ...listing.entries[0], path }] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["entries", 0, "path"]);
    }
  });
});
