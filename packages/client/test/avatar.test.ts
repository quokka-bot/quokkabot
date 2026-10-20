import { describe, expect, it } from "vitest";
import { AGENT_COLOURS, AGENT_SHAPES } from "@quokkabot/shared";
import { agentLook, COLOUR_HEX, eyeCentres, SHAPE_GEOMETRY, slotLook } from "../src/index.js";

function contrastWithWhite(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

describe("agent looks", () => {
  it("keeps the order of shapes and colours, which existing agents' looks depend on", () => {
    expect(AGENT_SHAPES).toEqual(["blob", "ghost", "squircle", "pebble", "cloud", "scallop", "egg", "drop", "gumdrop", "capsule"]);
    expect(AGENT_COLOURS).toEqual(["violet", "red", "pink", "brown", "grey", "ink", "orange", "sky", "green", "teal"]);
  });
  it("gives slots 1 to 8 their old colours and a different shape each", () => {
    const looks = Array.from({ length: 8 }, (_, position) => slotLook(position + 1));
    expect(looks.map(look => COLOUR_HEX[look.colour])).toEqual(["#8b5cf6", "#ef4444", "#ec4899", "#a16207", "#6b7280", "#111827", "#ea580c", "#0284c7"]);
    expect(new Set(looks.map(look => look.shape)).size).toBe(8);
    expect(slotLook(1)).toEqual({ shape: "blob", colour: "violet" });
  });
  it("gives every slot from 1 to 100 a different look, the same one every time", () => {
    const keys = Array.from({ length: 100 }, (_, position) => JSON.stringify(slotLook(position + 1)));
    expect(new Set(keys).size).toBe(100);
    expect(slotLook(37)).toEqual(slotLook(37));
  });
  it("refuses a slot that does not exist", () => {
    for (const index of [0, -1, 1.5, Number.NaN]) expect(() => slotLook(index)).toThrow("Agent slot must be a positive integer");
  });
  it("prefers the owner's pick and otherwise follows the slot", () => {
    expect(agentLook({ index: 3, look: null })).toEqual(slotLook(3));
    expect(agentLook({ index: 3, look: { shape: "cloud", colour: "teal" } })).toEqual({ shape: "cloud", colour: "teal" });
  });
  it("keeps white eyes readable on every colour", () => {
    for (const colour of AGENT_COLOURS) expect(contrastWithWhite(COLOUR_HEX[colour]), colour).toBeGreaterThanOrEqual(3);
  });
  it("draws every shape with its eyes inside the box", () => {
    expect(Object.keys(SHAPE_GEOMETRY).sort()).toEqual([...AGENT_SHAPES].sort());
    for (const shape of AGENT_SHAPES) {
      const { left, right } = eyeCentres(SHAPE_GEOMETRY[shape]);
      for (const eye of [left, right]) {
        expect(eye.x, shape).toBeGreaterThan(10);
        expect(eye.x, shape).toBeLessThan(54);
        expect(eye.y, shape).toBeGreaterThan(10);
        expect(eye.y, shape).toBeLessThan(54);
      }
    }
  });
});
