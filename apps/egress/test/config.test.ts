import { expect, it, vi } from "vitest";
import { EgressConfig } from "@quokkabot/shared";
import { Resolver } from "node:dns/promises";
import { createEgress } from "../src/egress.js";

function config() {
  return EgressConfig.parse({
    listeners: [{ name: "browser-1", address: "127.0.0.1", port: 9001, agentId: "00000000-0000-4000-8000-000000000001", kind: "browser" }],
    control: { address: "127.0.0.1", port: 9002, tokenFile: "/test/token" }, resolvers: ["1.1.1.1", "2606:4700:4700::1111"],
  });
}
it("configures exactly the specified DNS servers without a system lookup", async () => {
  const setServers = vi.spyOn(Resolver.prototype, "setServers");
  const cancel = vi.spyOn(Resolver.prototype, "cancel");
  try {
    const egress = createEgress({ config: config(), controlToken: "secret" });
    expect(setServers).toHaveBeenCalledExactlyOnceWith(["1.1.1.1", "2606:4700:4700::1111"]);
    expect(() => egress.addresses()).toThrow("Egress is not listening");
    await egress.close();
    await egress.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(egress.start()).rejects.toThrow("Egress can only be started once");
  } finally { setServers.mockRestore(); cancel.mockRestore(); }
});
it("fails fast on invalid token, config and duplicate listener identities or endpoints", () => {
  for (const controlToken of ["", "has space", "line\nbreak"]) expect(() => createEgress({ config: config(), controlToken })).toThrow("Control token");
  const invalid = config();
  invalid.listeners[0]!.port = 0;
  expect(() => createEgress({ config: invalid, controlToken: "secret" })).toThrow();
  const duplicatePort = config();
  duplicatePort.control.port = 9001;
  expect(() => createEgress({ config: duplicatePort, controlToken: "secret" })).toThrow("addresses and ports must be unique");
  const duplicateName = config();
  duplicateName.listeners.push({ ...duplicateName.listeners[0]!, port: 9003 });
  expect(() => createEgress({ config: duplicateName, controlToken: "secret" })).toThrow("names must be unique");
});
