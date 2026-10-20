// Facts the pages share. Change them here, never in a page.

export const GITHUB_URL = "https://github.com/quokka-bot/quokkabot";
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new/choose`;
export const GITHUB_DISCUSSIONS_URL = `${GITHUB_URL}/discussions`;
export const GITHUB_SECURITY_URL = `${GITHUB_URL}/security/advisories/new`;
export const INSTALL_GUIDE_URL = `${GITHUB_URL}/blob/main/docs/install.md`;

export const SUPPORT_EMAIL = "support@quokkabot.com";

// The Mac app is served by the project's own server until releases move to GitHub. public/_redirects sends
// /download/mac here; a test keeps the two in step.
export const MAC_DOWNLOAD = {
  version: "0.2.1",
  url: "https://app.quokkabot.com/desktop/QuokkaBot-0.2.1-arm64.dmg",
} as const;

// Who runs quokkabot.com, the support address and the apps' store listings. The privacy policy names them because
// data protection law requires it.
export const OPERATOR = {
  name: "MB Nexus consulting",
  address: ["Leičių g. 17-20", "LT-12109 Vilnius", "Lithuania"],
} as const;

// Date of the current privacy policy. The full history is the git log of src/pages/privacy.astro.
export const PRIVACY_UPDATED = "2026-10-20";

// Pages build to /privacy.html (build.format "file") and are served at /privacy; the home page is /.
export function publicPath(pathname: string): string {
  const path = pathname.replace(/\.html$/, "");
  return path === "/index" ? "/" : path;
}
