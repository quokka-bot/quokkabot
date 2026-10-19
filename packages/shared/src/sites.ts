// Sites as browsers see them: a registrable domain and its subdomains. Node-only (the rule data is 170 KB); import from
// "@quokkabot/shared/node", never from the web app.
import suffixRules from "./public-suffix-rules.json" with { type: "json" };

// ICANN and PRIVATE rules: two unrelated github.io tenants are different sites. A data snapshot; see
// PUBLIC-SUFFIX-NOTICE.txt beside it for provenance and licensing.
const SUFFIX_RULES = new Set<string>(suffixRules);

/** The registrable domain of a hostname (auth.roblox.com → roblox.com), or null for an IP, a single label or a public suffix itself. */
export function registrableDomain(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name.includes(":") || /^[\d.]+$/.test(name)) return null;
  const labels = name.split(".");
  let suffixLength = 1;
  for (let start = 0; start < labels.length; start += 1) {
    const suffix = labels.slice(start).join(".");
    if (SUFFIX_RULES.has(`!${suffix}`)) { suffixLength = labels.length - start - 1; break; }
    if (SUFFIX_RULES.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - start);
    if (start > 0 && SUFFIX_RULES.has(`*.${suffix}`)) suffixLength = Math.max(suffixLength, labels.length - start + 1);
  }
  if (labels.length <= suffixLength) return null;
  return labels.slice(-suffixLength - 1).join(".");
}

/**
 * The browser rule for the site of a host or host pattern: *.<registrable domain>, which matches the site and every
 * subdomain. A host that is itself a public suffix keeps its exact name; a wildcard over a public suffix is refused.
 */
export function sitePattern(pattern: string): string {
  const host = pattern.toLowerCase().replace(/\.$/, "").replace(/^\*\./, "");
  const site = registrableDomain(host);
  if (site !== null) return `*.${site}`;
  if (pattern.startsWith("*.")) throw new Error(`${pattern} covers every site under a public suffix`);
  return host;
}

/** One rule per site, in first-seen order. */
export function sitePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(sitePattern))];
}
