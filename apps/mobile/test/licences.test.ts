import { expect, it } from "vitest";
import { copyleftFree } from "../../../scripts/licence-expression.mjs";
import { podLicences } from "../../../scripts/pod-licences.mjs";

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

const lock = ["PODS:", "  - ExpoAsset (58.0.1):", "    - ExpoModulesCore", "  - ExpoModulesCore (58.0.9)", "  - React-Core/Default (0.88.0)", ""].join("\n");
const allowed = (licence: string) => copyleftFree(licence, copyleft);

it("reads every pod's licence from its podspec, once per pod", () => {
  const specs: Record<string, unknown> = { ExpoAsset: { license: "MIT" }, ExpoModulesCore: { license: { type: "MIT" } }, "React-Core": { license: "MIT" } };
  expect(podLicences(lock, (name: string) => specs[name] ?? null, allowed)).toEqual({ pods: 3, problems: [] });
});

it("fails a pod without a podspec, without a licence in it, or with a copyleft licence", () => {
  const specs: Record<string, unknown> = { ExpoModulesCore: { license: { file: "LICENSE" } }, "React-Core": { license: "GPL-3.0-only" } };
  expect(podLicences(lock, (name: string) => specs[name] ?? null, allowed).problems).toEqual([
    "pod ExpoAsset: no podspec", "pod ExpoModulesCore: no licence in its podspec", "pod React-Core: GPL-3.0-only",
  ]);
});
