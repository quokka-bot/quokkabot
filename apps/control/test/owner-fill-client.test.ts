import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerFillRequest } from "@quokkabot/shared";
import { BrowserServiceClient, UpstreamError } from "../src/clients.js";

const request: OwnerFillRequest = { commandId: "owner_command", leaseGeneration: 9, kind: "code", value: "native-client-canary", expectedOrigin: "https://example.com", submit: true };
describe("owner browser service client", () => {
  let client: BrowserServiceClient;
  let status: number;
  let response: unknown;
  let calls: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  beforeEach(() => {
    status = 200; response = {}; calls = [];
    const transport = (options: http.RequestOptions, listener: (reply: http.IncomingMessage) => void) => {
      const req = new EventEmitter() as http.ClientRequest;
      req.setTimeout = () => req;
      req.end = ((payload?: string) => {
        calls.push({ method: String(options.method), path: String(options.path), authorization: (options.headers as Record<string, string>).authorization,
          body: payload ? JSON.parse(payload) : null });
        const reply = Readable.from([Buffer.from(JSON.stringify(response))]);
        Object.assign(reply, { statusCode: status, headers: {} });
        listener(reply as http.IncomingMessage);
        return req;
      }) as typeof req.end;
      return req;
    };
    vi.spyOn(http, "request").mockImplementation(transport as typeof http.request);
    client = new BrowserServiceClient("http://browser-service:3000", "service-token");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("uses only the owner routes with the service credential and current lease generation", async () => {
    response = { field: { kind: "code", origin: request.expectedOrigin } };
    expect(await client.ownerFocus(9)).toEqual(response);
    response = { commandId: request.commandId, status: "ok" };
    expect(await client.ownerFill(request)).toEqual(response);
    expect(calls).toEqual([
      { method: "GET", path: "/v1/owner-focus?generation=9", authorization: "Bearer service-token", body: null },
      { method: "POST", path: "/v1/owner-fill", authorization: "Bearer service-token", body: request },
    ]);
  });

  it.each([200, 409, 500])("drops an invalid or failed fill reply's contents under HTTP %s", async (code) => {
    status = code; response = { error: request.value };
    await expect(client.ownerFill(request)).rejects.toThrow("owner fill failed");
    try { await client.ownerFill(request); }
    catch (error) { expect(String(error)).not.toContain(request.value); }
  });

  it.each(["blocked", "failed"])("distinguishes a %s focus refusal without retaining the reply", async (kind) => {
    status = 409; response = { status: kind, message: request.value };
    try {
      await client.ownerFocus(9);
      expect.fail("Expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBe(kind === "blocked" ? 409 : null);
      expect((error as UpstreamError).body).toBe("");
      expect(String(error)).not.toContain(request.value);
    }
  });
});
