// The site's promises: no scripts, nothing loaded from other origins, a working Mac download link, and a privacy page
// that names everyone the software sends data to.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAC_DOWNLOAD, OPERATOR, SUPPORT_EMAIL } from "../src/lib/site";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return files(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

describe("headers", () => {
  const headers = read("public/_headers");
  const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";

  it("blocks everything by default and allows no scripts", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("loads styles, images and fonts only from the site itself", () => {
    for (const directive of ["style-src", "img-src", "font-src"]) {
      expect(csp).toMatch(new RegExp(`${directive} 'self'(;|$)`));
    }
  });
});

describe("pages and styles", () => {
  const sources = [...files("src", /\.(astro|css|ts)$/), ...files("public", /\.(html|css|svg)$/)];

  it("contain no script tags", () => {
    for (const file of sources) expect(read(file), file).not.toMatch(/<script\b/i);
  });

  it("load nothing from another origin", () => {
    // Links to other sites are fine; anything the browser would fetch by itself is not.
    const fetched = /(?:\bsrc=|\bsrcset=|url\(|@import\s|<link\b[^>]*\bhref=)["']?\s*(?:https?:)?\/\//i;
    for (const file of sources) expect(read(file), file).not.toMatch(fetched);
  });
});

describe("Mac download", () => {
  it("redirects /download/mac to the same file the pages describe", () => {
    const rule = read("public/_redirects").split("\n").find((line) => line.startsWith("/download/mac "));
    expect(rule?.split(/\s+/)).toEqual(["/download/mac", MAC_DOWNLOAD.url, "302"]);
    expect(MAC_DOWNLOAD.url).toContain(`QuokkaBot-${MAC_DOWNLOAD.version}-arm64.dmg`);
  });
});

describe("privacy page", () => {
  const page = read("src/pages/privacy.astro");

  it("names everyone the software or the website sends data to", () => {
    for (const party of ["Anthropic", "Google", "Let's Encrypt", "Cloudflare (1.1.1.1)", "Quad9 (9.9.9.9)", "DuckDuckGo", "Apple", "GitHub", "Cloudflare Email Routing"]) {
      expect(page, party).toContain(party);
    }
  });

  it("names the operator and the contact address", () => {
    expect(page).toContain("OPERATOR.name");
    expect(page).toContain("OPERATOR.address");
    expect(page).toContain("SUPPORT_EMAIL");
    expect(OPERATOR.name.length).toBeGreaterThan(0);
    expect(SUPPORT_EMAIL).toMatch(/@quokkabot\.com$/);
  });
});
