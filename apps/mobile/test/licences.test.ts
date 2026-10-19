import { expect, it } from "vitest";
import { copyleftFree } from "../../../scripts/licence-expression.mjs";

// The licence check of what the App Store build ships (scripts/check-mobile-licenses.mjs).
const copyleft = (licence: string) => /\b(A?GPL|LGPL|SSPL)/i.test(licence);

it.each([
  ["MIT", true],
  ["(MIT OR Apache-2.0)", true],
  ["MIT OR GPL-3.0-or-later", true],
  ["GPL-3.0-only", false],
  ["GPL-2.0-only AND (MIT OR Apache-2.0)", false],
  ["(MIT OR Apache-2.0) AND LGPL-2.1-only", false],
  ["MIT AND BSD-3-Clause OR GPL-2.0-only", true],
  ["MIT AND (BSD-3-Clause OR GPL-2.0-only)", true],
  ["GPL-2.0-only WITH Classpath-exception-2.0 OR MIT", true],
  ["GPL-2.0-only WITH Classpath-exception-2.0", false],
  ["mit or apache-2.0", true],
])("%s: copyleft free is %s", (expression, free) => {
  expect(copyleftFree(expression, copyleft)).toBe(free);
});

it("reads a field that is not an expression as a whole: it passes only without a copyleft name", () => {
  expect(copyleftFree("SEE LICENSE IN LICENSE.md", copyleft)).toBe(true);
  expect(copyleftFree("Apache 2.0", copyleft)).toBe(true);
  expect(copyleftFree("GPL version 2 (see COPYING)", copyleft)).toBe(false);
  expect(copyleftFree("(MIT OR GPL-2.0-only", copyleft)).toBe(false);
});
