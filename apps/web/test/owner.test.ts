import { describe, expect, it } from "vitest";
import { ownerInitial } from "../src/owner.js";

describe("the owner avatar's initial", () => {
  it.each([
    ["Robin", "R"],
    ["robin", "R"],
    ["Ąžuolas", "Ą"],
    ["ąžuolas", "Ą"],
    ["E\u0301mile", "E\u0301"],
    ["émile", "É"],
    ["👩‍💻 Kim", "👩‍💻"],
    ["👍🏽 Sam", "👍🏽"],
    ["ßigi", "ß"],
    ["a\u0345da", "a\u0345"],
    ["李小龍", "李"],
  ])("of %j is %j", (name, initial) => {
    expect(ownerInitial(name)).toBe(initial);
  });

  it("needs a name", () => {
    expect(() => ownerInitial("")).toThrow("ownerInitial needs a name");
  });
});
