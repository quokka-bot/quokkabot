import { expect, it } from "vitest";
import { viewerMayLoad } from "../src/computer/viewer-policy";

const view = "https://view.example.com";

it("loads the viewer origin and about:blank", () => {
  expect(viewerMayLoad("https://view.example.com/agents/a/?ticket=t", view)).toBe(true);
  expect(viewerMayLoad("about:blank", view)).toBe(true);
});

it.each([
  "https://example.org/", "http://view.example.com/", "https://view.example.com.evil.example/", "https://view.example.com:8443/",
  "tel:+37060000000", "mailto:owner@example.com", "itms-apps://apps.apple.com/app/id1", "javascript:alert(1)", "not a url", "",
])("refuses %s", (url) => {
  expect(viewerMayLoad(url, view)).toBe(false);
});
