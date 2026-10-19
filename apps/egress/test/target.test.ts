import { expect, it } from "vitest";
import { hostHeaderMatches, isIpLiteral, normalizeHost, parseTarget } from "../src/target.js";

it.each([
  "127.0.0.1", "8.8.8.8", "[::1]", "[::ffff:127.0.0.1]", "[2606:4700::1111]",
  "2130706433", "0x7f000001", "017700000001", "0177.0.0.1", "127.1", "127.0.1",
  "0x7f.0.0.1", "127.0.0.1.", "%31%32%37.0.0.1", "１２７.０.０.１",
])("refuses IP literal %s before hostname normalization", (host) => {
  expect(isIpLiteral(host)).toBe(true);
  expect(parseTarget("CONNECT", `${host}:443`, "browser")).toMatchObject({ decision: "blocked_ip_literal" });
  expect(parseTarget("GET", `http://${host}/path?private=value`, "browser")).toMatchObject({ decision: "blocked_ip_literal" });
});
it("normalizes case, one trailing dot and IDNA", () => {
  expect(normalizeHost("BÜCHER.Example.")).toBe("xn--bcher-kva.example");
  expect(parseTarget("GET", "http://Billing.Example.COM.:80/file?q=1", "browser")).toEqual({ target: { host: "billing.example.com", port: 80, path: "/file?q=1", connect: false } });
  expect(parseTarget("GET", "http://example.com?q=1", "browser")).toMatchObject({ target: { path: "/?q=1" } });
});
it.each(["", "x..example", "-x.example", "x-.example", "a".repeat(64) + ".example", "example.com..", "user@example.com", "example.com/path", "example.com\\secret"])("refuses invalid hostname %s", (host) => {
  expect(normalizeHost(host)).toBe(null);
});
it.each([
  ["GET", "/path", "browser", "blocked_method"], ["GET", "https://example.com/", "browser", "blocked_method"],
  ["GET", "http://example.com/", "cli", "blocked_method"], ["CONNECT", "example.com:8443", "browser", "blocked_port"],
  ["GET", "http://example.com:8080/", "browser", "blocked_port"], ["CONNECT", "example.com", "browser", "blocked_domain"],
  ["CONNECT", "example.com:443/path?secret", "browser", "blocked_domain"], ["GET", "http://user:secret@example.com/", "browser", "blocked_domain"],
  ["GET", "http://example.com/path#fragment", "browser", "blocked_domain"], ["GET", "http://example.com\\evil.test/path", "browser", "blocked_domain"],
] as const)("validates target %s %s on %s", (method, url, kind, decision) => {
  const parsed = parseTarget(method, url, kind);
  expect(parsed).toMatchObject({ decision });
  expect(JSON.stringify(parsed)).not.toContain("secret");
});
it("compares Host as an authority with the HTTP default port", () => {
  expect(hostHeaderMatches("EXAMPLE.com.:80", "example.com")).toBe(true);
  for (const header of ["evil.com", "example.com:443", "example.com@evil.com", "example.com/path", "example.com,evil.com", "127.1"]) {
    expect(hostHeaderMatches(header, "example.com")).toBe(false);
  }
});
