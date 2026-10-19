import { expect, it, vi } from "vitest";
import { draftId } from "../src/chat/id";

it("uses the runtime's randomUUID when present", () => {
  const source = { randomUUID: vi.fn().mockReturnValue("runtime-uuid") };
  const random = vi.fn();
  expect(draftId(source, random)).toBe("runtime-uuid");
  expect(source.randomUUID).toHaveBeenCalledOnce();
  expect(random).not.toHaveBeenCalled();
});
it("generates UUID v4 version and variant bits without a crypto dependency", () => {
  expect(draftId({}, () => 0)).toBe("00000000-0000-4000-8000-000000000000");
  expect(draftId({}, () => 0.999)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  const ids = Array.from({ length: 100 }, () => draftId({}));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
