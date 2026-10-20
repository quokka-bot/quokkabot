import { AI_PROVIDERS } from "@quokkabot/shared";
import { describe, expect, it } from "vitest";
import { type ConsentRow, consentView } from "../src/consent.js";

const CURRENT = AI_PROVIDERS.anthropic.disclosureVersion;
const at = new Date("2026-10-20T10:00:00Z");
const allow = (version: string = CURRENT): ConsentRow => ({ granted: true, disclosure_version: version, decided_at: at, client: "phone", device_name: "iPhone" });
const withdraw: ConsentRow = { granted: false, disclosure_version: null, decided_at: at, client: "browser", device_name: "Browser" };

describe("AI consent decisions", () => {
  it("sends on a self-hosted server until the owner withdraws", () => {
    expect(consentView(null, false, "anthropic")).toMatchObject({ state: "not_asked", allowed: true, changedBy: null });
    expect(consentView(withdraw, false, "anthropic")).toMatchObject({ state: "withdrawn", allowed: false, changedBy: { client: "browser" } });
  });

  it("sends on a server that requires consent only after an allow under the current disclosure", () => {
    expect(consentView(null, true, "anthropic")).toMatchObject({ state: "not_asked", allowed: false });
    expect(consentView(allow(), true, "anthropic")).toMatchObject({ state: "granted", allowed: true, changedAt: at.toISOString() });
    expect(consentView(allow("2026-01-01"), true, "anthropic")).toMatchObject({ state: "not_asked", allowed: false });
    expect(consentView(withdraw, true, "anthropic")).toMatchObject({ state: "withdrawn", allowed: false });
  });

  it("names the provider and the disclosure the apps must show", () => {
    expect(consentView(null, true, "anthropic")).toMatchObject({ provider: "anthropic", disclosureVersion: CURRENT, required: true });
  });
});
