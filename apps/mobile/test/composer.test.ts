import { describe, expect, it, vi } from "vitest";
import type { Task } from "@quokkabot/shared";
import { composerState, sendDraft } from "../src/chat/composer-state";

const task = { id: "task-id", state: "running", blockedReason: null } as Task;
const result = { ...task, state: "queued" } as Task;
function api() {
  return { createTask: vi.fn().mockResolvedValue(result), reply: vi.fn().mockResolvedValue(result), message: vi.fn().mockResolvedValue(result) };
}

it("creates a task with the draft's idempotency key, then keeps the same key on a retry", async () => {
  const calls = api();
  const draft = { agentId: "agent-id", task: null, waiting: false, ready: true, text: "  Get the invoice  ", draftKey: "draft-key" };
  calls.createTask.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(sendDraft(calls, draft)).rejects.toThrow("Disconnected");
  expect(await sendDraft(calls, draft)).toBe(result);
  expect(calls.createTask.mock.calls).toEqual([["agent-id", "Get the invoice", "draft-key"], ["agent-id", "Get the invoice", "draft-key"]]);
  expect(calls.reply).not.toHaveBeenCalled();
  expect(calls.message).not.toHaveBeenCalled();
});

it.each(["queued", "running"] as const)("replies to an active %s task waiting for a question or any other card", async state => {
  const calls = api();
  await sendDraft(calls, { agentId: "agent-id", task: { ...task, state }, waiting: true, ready: true, text: "Answer", draftKey: "key" });
  expect(calls.reply).toHaveBeenCalledExactlyOnceWith(task.id, "Answer");
  expect(calls.createTask).not.toHaveBeenCalled();
  expect(calls.message).not.toHaveBeenCalled();
});

it.each(["completed", "failed", "outcome_unknown", "cancelled"] as const)("messages a %s task even when stale cards remain", async state => {
  const calls = api();
  await sendDraft(calls, { agentId: "agent-id", task: { ...task, state }, waiting: true, ready: true, text: "Continue", draftKey: "key" });
  expect(calls.message).toHaveBeenCalledExactlyOnceWith(task.id, "Continue");
  expect(calls.createTask).not.toHaveBeenCalled();
  expect(calls.reply).not.toHaveBeenCalled();
});

it.each([
  { task, waiting: false, ready: true, text: "Hello" },
  { task: { ...task, state: "queued" as const }, waiting: false, ready: true, text: "Hello" },
  { task: null, waiting: false, ready: false, text: "Hello" },
  { task: null, waiting: false, ready: true, text: " \n " },
])("sends nothing while working, not loaded or empty: %j", async input => {
  const calls = api();
  expect(await sendDraft(calls, { ...input, agentId: "agent-id", draftKey: "key" })).toBeNull();
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
});

describe("composer copy", () => {
  it("matches the web's new, answer, reply, working, blocked and message placeholders", () => {
    expect(composerState("Quokka", null, false, null)).toEqual({ route: "createTask", running: false, placeholder: "New task for Quokka" });
    expect(composerState("Quokka", task, true, { kind: "question" }).placeholder).toBe("Answer Quokka");
    expect(composerState("Quokka", task, true, { kind: "login" }).placeholder).toBe("Reply to Quokka");
    expect(composerState("Quokka", task, true, null).placeholder).toBe("Reply to Quokka");
    expect(composerState("Quokka", task, false, null)).toEqual({ route: null, running: true, placeholder: "Quokka is working…" });
    expect(composerState("Quokka", { ...task, blockedReason: "takeover" }, false, null).placeholder).toBe("Quokka is waiting for you above");
    expect(composerState("Quokka", { ...task, state: "completed" }, false, null)).toEqual({ route: "message", running: false, placeholder: "Message Quokka" });
  });
});
