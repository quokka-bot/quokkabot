import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutate: vi.fn(), invalidate: vi.fn(), consent: vi.fn(), allowed: false, pending: false,
  options: undefined as { onSuccess: () => void } | undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
  useMutation: (options: { onSuccess: () => void }) => { state.options = options; return { mutate: state.mutate, isPending: state.pending }; },
}));
vi.mock("../src/session", () => ({ useSignedIn: () => ({ connection: { origin: "https://server.example.com" } }) }));
vi.mock("../src/consent", () => ({ withConsent: (origin: string, agentId: string, send: () => void) => {
  state.consent(origin, agentId);
  if (state.allowed) send();
} }));
import { useAction } from "../src/chat/use-action";

beforeEach(() => { vi.clearAllMocks(); state.allowed = false; state.pending = false; });
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
