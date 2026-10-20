import { expect, it, vi } from "vitest";

const accessibility = vi.hoisted(() => ({
  changed: undefined as ((value: boolean) => void) | undefined,
  answer: undefined as ((value: boolean) => void) | undefined,
  subscriptions: 0,
}));
vi.mock("react-native", () => ({ AccessibilityInfo: {
  addEventListener: (_event: string, listener: (value: boolean) => void) => { accessibility.subscriptions += 1; accessibility.changed = listener; return { remove: vi.fn() }; },
  isReduceMotionEnabled: () => new Promise<boolean>(resolve => { accessibility.answer = resolve; }),
} }));

it("keeps avatars still until iOS answers, follows the setting after, and asks iOS only once", async () => {
  const { reduceMotionNow, subscribeReduceMotion } = await import("../src/ui/reduce-motion");
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeReduceMotion(first);
  subscribeReduceMotion(second);
  expect(reduceMotionNow()).toBe(true);
  expect(accessibility.subscriptions).toBe(1);
  accessibility.answer?.(false);
  await Promise.resolve();
  expect(reduceMotionNow()).toBe(false);
  expect(first).toHaveBeenCalledOnce();
  stopFirst();
  accessibility.changed?.(true);
  expect(reduceMotionNow()).toBe(true);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledTimes(2);
});
