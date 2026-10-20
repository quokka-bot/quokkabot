import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutate: vi.fn(), invalidate: vi.fn(), consent: vi.fn(), refused: vi.fn(), refusal: false, allowed: false, pending: false,
  options: undefined as { onSuccess: () => void; onError: (error: unknown) => void } | undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
  useMutation: (options: { onSuccess: () => void; onError: (error: unknown) => void }) => { state.options = options; return { mutate: state.mutate, isPending: state.pending }; },
}));
vi.mock("../src/session", () => ({ useSignedIn: () => ({ connection: { origin: "https://server.example.com" } }) }));
vi.mock("../src/consent", () => ({
  withConsent: (origin: string, agentId: string, send: () => void) => {
    state.consent(origin, agentId);
    if (state.allowed) send();
  },
  consentRefused: (origin: string, agentId: string, error: unknown) => { state.refused(origin, agentId, error); return state.refusal; },
}));
import { useAction } from "../src/chat/use-action";

beforeEach(() => { vi.clearAllMocks(); state.allowed = false; state.pending = false; state.refusal = false; });
it("runs no agent mutation unless the consent callback permits it", () => {
  const action = useAction("agent-id", async (text: string) => text);
  action.run("Answer");
  expect(state.consent).toHaveBeenCalledExactlyOnceWith("https://server.example.com", "agent-id");
  expect(state.mutate).not.toHaveBeenCalled();
  state.allowed = true;
  action.run("Answer");
  expect(state.mutate).toHaveBeenCalledExactlyOnceWith("Answer");
});
it("keeps local actions and stopping available without AI consent", () => {
  useAction("agent-id", async () => undefined, false).run();
  expect(state.consent).not.toHaveBeenCalled();
  expect(state.mutate).toHaveBeenCalledOnce();
});
it("does not start another action while one is pending", () => {
  state.allowed = true; state.pending = true;
  useAction("agent-id", async () => undefined).run();
  expect(state.mutate).not.toHaveBeenCalled();
});
it("refreshes queries only for the current server after an action", () => {
  useAction("agent-id", async () => undefined);
  state.options?.onSuccess();
  expect(state.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["https://server.example.com"] });
});
it("opens the permission screen when the server refuses a send for want of it, and refreshes the agent", () => {
  useAction("agent-id", async () => undefined);
  const refusal = new Error("refused");
  state.options?.onError(new Error("other"));
  expect(state.invalidate).not.toHaveBeenCalled();
  state.refusal = true;
  state.options?.onError(refusal);
  expect(state.refused).toHaveBeenLastCalledWith("https://server.example.com", "agent-id", refusal);
  expect(state.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["https://server.example.com"] });
});
it("leaves errors of actions that need no permission alone", () => {
  useAction("agent-id", async () => undefined, false);
  state.options?.onError(new Error("other"));
  expect(state.refused).not.toHaveBeenCalled();
});
