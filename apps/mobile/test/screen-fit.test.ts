import { expect, it } from "vitest";
import { needsRefit, screenFor } from "../src/computer/screen-fit";

it("keeps a portrait view's shape at the narrowest width Chrome fits on", () => {
  // iPhone 17 Pro: 393 points wide.
  expect(screenFor({ width: 393, height: 659.67 })).toEqual({ width: 504, height: 846 });
  expect(screenFor({ width: 440, height: 700 })).toEqual({ width: 504, height: 802 });
});

it("uses one screen pixel per point when the view is wide enough", () => {
  // Landscape on an iPhone 17 Pro; widths round up to whole 8-pixel cells.
  expect(screenFor({ width: 874, height: 301 })).toEqual({ width: 880, height: 302 });
  expect(screenFor({ width: 504, height: 600 })).toEqual({ width: 504, height: 600 });
});

it("leaves the desktop size when the view is outside the sizes the server accepts", () => {
  expect(screenFor({ width: 874, height: 200 })).toBeNull();
  expect(screenFor({ width: 2048, height: 1500 })).toBeNull();
  expect(screenFor({ width: 0, height: 0 })).toBeNull();
});

it("fits again only when the width changes", () => {
  const portrait = { width: 504, height: 846 };
  expect(needsRefit(null, portrait)).toBe(true);
  expect(needsRefit(portrait, { width: 504, height: 600 })).toBe(false);
  expect(needsRefit(portrait, { width: 880, height: 302 })).toBe(true);
  expect(needsRefit(portrait, null)).toBe(false);
  expect(needsRefit(null, null)).toBe(false);
});
