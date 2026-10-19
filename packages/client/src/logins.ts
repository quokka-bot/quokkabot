import { DomainPattern } from "@quokkabot/shared";

export function validateTotp(value: string): string {
  const secret = value.trim();
  // Sites often show the secret in groups of four ("jbsw y3dp ..."); the server reads it with or without spaces.
  if (/^[A-Z2-7]{16,}={0,6}$/i.test(secret.replace(/[\s-]/g, ""))) return secret;
  if (secret.startsWith("otpauth://") && URL.canParse(secret)) {
    const uri = new URL(secret);
    if (uri.hostname === "totp" && uri.pathname.length > 1 && /^[A-Z2-7]{16,}={0,6}$/i.test(uri.searchParams.get("secret") ?? "")) return secret;
  }
  throw new Error("2FA must be a base32 secret of at least 16 characters or an otpauth://totp URI containing one.");
}

// The web form's required fields stop an empty name, username or new password before saving. A native form has no
// such attribute: it asks this first, so the owner reads one plain line instead of the schema's error.
export function requireLoginFields(fields: { name: string; username: string; password?: string }): void {
  if (fields.name.trim() === "") throw new Error("Type a name for this login.");
  if (fields.username === "") throw new Error("Type the username or email.");
  if (fields.password === "") throw new Error("Type the password.");
}

export function loginSites(sites: string): string[] {
  // A pasted address counts as its site: https://www.roblox.com/login is roblox.com, which the server stores as a site.
  const patterns = sites.split(",").map(site => site.trim().toLowerCase()).map(site => URL.canParse(site) && /^https?:\/\//.test(site) ? new URL(site).hostname : site);
  for (const pattern of patterns) {
    if (!DomainPattern.safeParse(pattern).success) throw new Error(`Invalid site: ${pattern || "(empty)"}. Enter sites such as example.com, separated by commas.`);
  }
  return patterns;
}
