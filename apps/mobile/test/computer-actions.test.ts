import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ consent: vi.fn(), allowed: false }));
vi.mock("../src/consent", () => ({ withConsent: (origin: string, agentId: string, send: () => void) => {
  state.consent(origin, agentId);
  if (state.allowed) send();
} }));
import { handBack, setAttended } from "../src/computer/actions";

const origin = "https://server.example.com";
const api = { takeover: vi.fn(async () => undefined), takeoverDone: vi.fn(async () => undefined), attended: vi.fn(async () => undefined) };
const run = (work: () => Promise<unknown>) => { void work(); };

beforeEach(() => { vi.clearAllMocks(); state.allowed = false; });

it("hands control back to the agent only with the AI provider permission, for both kinds of takeover", () => {
  handBack(origin, "agent-id", null, api as never, run);
  handBack(origin, "agent-id", "task-id", api as never, run);
  expect(state.consent).toHaveBeenCalledTimes(2);
  expect(api.takeover).not.toHaveBeenCalled();
  expect(api.takeoverDone).not.toHaveBeenCalled();
  state.allowed = true;
  handBack(origin, "agent-id", null, api as never, run);
  handBack(origin, "agent-id", "task-id", api as never, run);
  expect(api.takeover).toHaveBeenCalledExactlyOnceWith("agent-id", "return");
  expect(api.takeoverDone).toHaveBeenCalledExactlyOnceWith("task-id");
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
