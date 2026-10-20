import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// The avatars' rules for calm motion, read from the stylesheet: no loop faster than three seconds, short reactions,
// hover only where a pointer can hover, and nothing left moving under Reduce motion.
const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/g)].map(match => match[1]).join("\n");

it("loops avatar animations no faster than every three seconds", () => {
  const loops = [...css.matchAll(/animation: (avatar-[\w-]+) ([\d.]+)s [\w-]+ infinite/g)];
  expect(loops.length).toBeGreaterThan(0);
  for (const [, name, seconds] of loops) expect(Number(seconds), name).toBeGreaterThanOrEqual(3);
});

it("stops every avatar animation and transition under reduced motion", () => {
  const animated = [...css.matchAll(/^(\.agent-avatar\[data-state="working"\] \.avatar-[\w-]+) \{ animation:/gm)].map(match => match[1]);
  expect(animated.length).toBeGreaterThan(0);
  for (const selector of animated) expect(reduced, selector).toContain(selector);
  expect(reduced).toMatch(/\.avatar-breathe, [^{]*\.avatar-gaze, [^{]*\.avatar-blink \{ animation: none; \}/);
  const transitioned = [...css.matchAll(/^\.agent-avatar (\.avatar-[\w-]+) \{[^}]*transition:/gm)].map(match => match[1]);
  expect(transitioned.length).toBeGreaterThan(0);
  for (const part of transitioned) expect(reduced, part).toContain(`.agent-avatar ${part}`);
});

it("keeps every avatar reaction under 600 ms", () => {
  const reactions = [...css.matchAll(/^\.agent-avatar \.avatar-[\w-]+ \{[^}]*transition: [\w-]+ (\d+)ms/gm)];
  expect(reactions.length).toBeGreaterThan(0);
  for (const [rule, ms] of reactions) expect(Number(ms), rule).toBeLessThanOrEqual(600);
});

it("reacts to hover only on devices with a pointer that hovers", () => {
  const hoverBlock = /@media \(hover: hover\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const hoverRules = css.split("\n").filter(line => line.includes(":hover .avatar-"));
  expect(hoverRules.length).toBeGreaterThan(0);
  for (const rule of hoverRules) expect(hoverBlock, rule).toContain(rule.trim());
});
