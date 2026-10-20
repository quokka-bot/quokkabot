import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalUrl } from "../src/api.js";
import { agent, json, task } from "./fixtures.js";

const agentId = "6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10";

describe("terminalUrl", () => {
  it("uses wss for an https app", () => {
    expect(terminalUrl(agentId, { origin: "https://quokkabot.example.com", protocol: "https:" })).toBe(
      `wss://quokkabot.example.com/api/agents/${agentId}/terminal`,
    );
  });
  it("uses ws only for an http localhost app", () => {
    expect(terminalUrl(agentId, { origin: "http://localhost:8080", protocol: "http:" })).toBe(`ws://localhost:8080/api/agents/${agentId}/terminal`);
    expect(terminalUrl(agentId, { origin: "http://quokkabot.example.com", protocol: "http:" })).toBe(
      `wss://quokkabot.example.com/api/agents/${agentId}/terminal`,
    );
  });
});

describe("agent generation headers", () => {
  let api: typeof import("../src/api.js")["api"];
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    vi.resetModules();
    api = (await import("../src/api.js")).api;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  function sentHeader(index: number, name = "X-Quokkabot-Agent-Generation") {
    return new Headers(fetchMock.mock.calls[index]?.[1]?.headers).get(name);
  }

  it.each(["list", "summary", "create", "settings"])("remembers the generation from an agent %s", async source => {
    const current = { ...agent, generation: 7 };
    fetchMock.mockResolvedValueOnce(json(source === "list" ? { agents: [current], capacity: { used: 1, total: 3 } } : current));
    if (source === "list") await api.agents();
    else if (source === "summary") await api.agent(agent.id);
    else if (source === "create") await api.createAgent("Office");
    else await api.settings(agent.id, { effort: agent.effort });
    fetchMock.mockResolvedValueOnce(json(task));
    await api.createTask(agent.id, "Hello", "request-key");
    expect(sentHeader(1)).toBe("7");
    expect(sentHeader(1, "Idempotency-Key")).toBe("request-key");
    expect(sentHeader(1, "Content-Type")).toBe("application/json");
  });

  it("sends no generation for an unknown agent", async () => {
    fetchMock.mockResolvedValueOnce(json(task));
    await api.createTask(agent.id, "Hello", "key");
    expect(sentHeader(0)).toBeNull();
  });

  it("defaults old summaries to generation 1 and sends the header on GET and DELETE too", async () => {
    const { generation: _generation, ...old } = agent;
    fetchMock.mockResolvedValueOnce(json(old)).mockResolvedValueOnce(json({ tasks: [], nextBefore: null })).mockResolvedValueOnce(json({}));
    expect((await api.agent(agent.id)).generation).toBe(1);
    await api.tasks(agent.id);
    await api.removeAgent(agent.id);
    expect(sentHeader(1)).toBe("1");
    expect(sentHeader(2)).toBe("1");
  });

  it("updates the remembered generation on reuse and attaches it to raw uploads", async () => {
    fetchMock.mockResolvedValueOnce(json({ agents: [{ ...agent, generation: 2 }], capacity: { used: 1, total: 3 } }));
    await api.agents();
    fetchMock.mockResolvedValueOnce(json({ ...agent, generation: 3 }));
    await api.agent(agent.id);
    const image = new File(["image"], "test.png", { type: "image/png" });
    fetchMock.mockResolvedValueOnce(json({ id: "33333333-3333-4333-8333-333333333333", name: image.name, mediaType: image.type, bytes: image.size, width: 1, height: 1 }));
    await api.uploadImage(agent.id, image);
    expect(sentHeader(2)).toBe("3");
    expect(sentHeader(2, "Content-Type")).toBe("image/png");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(image);
  });

  it("keeps the last known generation after an empty list so stale requests stay fenced", async () => {
    fetchMock.mockResolvedValueOnce(json(agent)).mockResolvedValueOnce(json({ agents: [], capacity: { used: 0, total: 3 } })).mockResolvedValueOnce(json(task));
    await api.agent(agent.id);
    await api.agents();
    await api.createTask(agent.id, "Late message", "key");
    expect(sentHeader(2)).toBe(String(agent.generation));
  });

  it("does not attach an agent generation to unrelated paths", async () => {
    fetchMock.mockResolvedValueOnce(json(agent)).mockResolvedValueOnce(json({ ownerName: "Ada", passkeys: 1, freshUntil: null }));
    await api.agent(agent.id);
    await api.me();
    expect(sentHeader(1)).toBeNull();
  });
});
