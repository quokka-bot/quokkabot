import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ consent: vi.fn(), allowed: false }));
vi.mock("../src/consent", () => ({ withConsent: (origin: string, agentId: string, send: () => void) => {
  state.consent(origin, agentId);
  if (state.allowed) send();
} }));
import { handBack, setAttended } from "../src/computer/actions";

const asked = (taskId: string, agentId = "agent-id") => ({ items: [{ kind: "owner_request", agentId, request: { kind: "takeover", taskId, answeredAt: null } }] });

const origin = "https://server.example.com";
const api = { inbox: vi.fn(async () => ({ items: [] as unknown[] })), takeover: vi.fn(async () => undefined), takeoverDone: vi.fn(async () => undefined), attended: vi.fn(async () => undefined) };
const pending: Promise<unknown>[] = [];
const run = (work: () => Promise<unknown>) => { pending.push(work()); };
const settle = async () => { await Promise.all(pending.splice(0)); };

beforeEach(() => { vi.clearAllMocks(); state.allowed = false; });

it("hands control back to the agent only with the AI provider permission", async () => {
  handBack(origin, "agent-id", api as never, run);
  await settle();
  expect(state.consent).toHaveBeenCalledExactlyOnceWith(origin, "agent-id");
  expect(api.inbox).not.toHaveBeenCalled();
  expect(api.takeover).not.toHaveBeenCalled();
  expect(api.takeoverDone).not.toHaveBeenCalled();
  state.allowed = true;
  handBack(origin, "agent-id", api as never, run);
  await settle();
  expect(api.takeover).toHaveBeenCalledExactlyOnceWith("agent-id", "return");
});

it("answers a takeover request read at the tap, including one that arrived since the last refresh", async () => {
  state.allowed = true;
  api.inbox.mockResolvedValueOnce(asked("task-id"));
  handBack(origin, "agent-id", api as never, run);
  await settle();
  expect(api.takeoverDone).toHaveBeenCalledExactlyOnceWith("task-id");
  expect(api.takeover).not.toHaveBeenCalled();
  api.inbox.mockResolvedValueOnce(asked("other-task", "other-agent"));
  handBack(origin, "agent-id", api as never, run);
  await settle();
  expect(api.takeover).toHaveBeenCalledExactlyOnceWith("agent-id", "return");
});

it("opens the attended session only with the permission and closes it without asking", () => {
  setAttended(origin, "agent-id", true, api as never, run);
  expect(state.consent).toHaveBeenCalledExactlyOnceWith(origin, "agent-id");
  expect(api.attended).not.toHaveBeenCalled();
  setAttended(origin, "agent-id", false, api as never, run);
  expect(state.consent).toHaveBeenCalledOnce();
  expect(api.attended).toHaveBeenCalledExactlyOnceWith("agent-id", false);
  state.allowed = true;
  setAttended(origin, "agent-id", true, api as never, run);
  expect(api.attended).toHaveBeenLastCalledWith("agent-id", true);
});
