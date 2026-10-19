import { hostMatchesPattern, siteLabel, type LoginView, type OwnerRequest } from "@quokkabot/shared";

/** "roblox.com, rbxcdn.com and arkoselabs.com" */
export function listSites(patterns: readonly string[]): string {
  const sites = patterns.map(siteLabel);
  return sites.length <= 1 ? sites.join("") : `${sites.slice(0, -1).join(", ")} and ${sites.at(-1)}`;
}

export function loginRequestOptions(request: OwnerRequest, existing: LoginView | undefined) {
  const title = request.loginId === null ? `Sign in to ${request.site ?? "a site"}` : `Fix the ${request.loginName ?? "saved"} login`;
  // A saved login the agent needs on a site it does not cover yet, such as a shared sign-in page: one click adds the site.
  const otherSite = existing !== undefined && request.site !== null && !existing.sites.some((pattern) => hostMatchesPattern(request.site ?? "", pattern));
  // Gmail: no password here. Gmail is connected through Google's own page and the agent works through the Gmail API.
  // Only for Gmail itself: a Google sign-in for Drive or for another site's "Sign in with Google" keeps the login card.
  const site = request.site ?? "";
  const google = /(^|\.)(mail\.google\.com|gmail\.com)$/.test(site) || (site === "accounts.google.com" && /\b(g?mail|inbox|draft|email)\b/i.test(`${request.text} ${request.loginName ?? ""}`));
  return { title, otherSite, google };
}

