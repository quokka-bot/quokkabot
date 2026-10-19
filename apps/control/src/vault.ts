import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { LoginView } from "@quokkabot/shared";
import { sitePatterns } from "@quokkabot/shared/node";
import type { AuditLog } from "./audit.js";
import { type Db, many, maybeOne, one } from "./db.js";
import { HttpError } from "./errors.js";

// The login vault. Passwords and 2FA secrets are encrypted with AES-256-GCM under a key that lives in a secret file, not
// the database; each value is bound to its login and field. Values are never returned through the owner API or to the
// model: the browser service types them into pages on the login's own sites.

const VERSION = 1;

export function encryptValue(key: Buffer, loginId: string, field: string, value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${loginId}:${field}`));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
}

export function decryptValue(key: Buffer, loginId: string, field: string, sealed: Buffer): string {
  if (sealed.length < 1 + 12 + 16 || sealed[0] !== VERSION) throw new Error("vault value has an unknown format");
  const nonce = sealed.subarray(1, 13);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(13, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${loginId}:${field}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// --- TOTP (RFC 6238) -----------------------------------------------------------------------------------------------

export interface TotpSpec {
  secret: string; // base32, upper case, no padding
  digits: 6 | 7 | 8;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) throw new HttpError(400, "invalid_totp", "The 2FA secret is not valid base32.");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Accepts a base32 secret or an otpauth://totp/... URI as sites show them on their 2FA setup page.
export function parseTotp(input: string): TotpSpec {
  const text = input.trim();
  if (text.toLowerCase().startsWith("otpauth://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new HttpError(400, "invalid_totp", "The otpauth link is not valid.");
    }
    if (url.hostname !== "totp") throw new HttpError(400, "invalid_totp", "Only time-based (TOTP) codes are supported.");
    const secret = url.searchParams.get("secret") ?? "";
    const digits = Number(url.searchParams.get("digits") ?? "6");
    const period = Number(url.searchParams.get("period") ?? "30");
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    if (![6, 7, 8].includes(digits)) throw new HttpError(400, "invalid_totp", "Unsupported number of digits.");
    if (!Number.isInteger(period) || period < 10 || period > 300) throw new HttpError(400, "invalid_totp", "Unsupported period.");
    if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") throw new HttpError(400, "invalid_totp", "Unsupported algorithm.");
    base32Decode(secret);
    return { secret: secret.toUpperCase().replace(/[\s=-]/g, ""), digits: digits as 6 | 7 | 8, period, algorithm };
  }
  base32Decode(text);
  return { secret: text.toUpperCase().replace(/[\s=-]/g, ""), digits: 6, period: 30, algorithm: "SHA1" };
}

export function totpCode(spec: TotpSpec, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / spec.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(spec.algorithm.toLowerCase(), base32Decode(spec.secret)).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** spec.digits).padStart(spec.digits, "0");
}

// --- Logins --------------------------------------------------------------------------------------------------------

// A login belongs to sites, as in a password manager: one saved for roblox.com also fills on www.roblox.com and
// auth.roblox.com. Stored as *.<registrable domain>.
function loginSites(sites: string[]): string[] {
  try {
    return sitePatterns(sites);
  } catch (error) {
    throw new HttpError(400, "invalid_site", error instanceof Error ? error.message : "Invalid site.");
  }
}

interface LoginRow {
  id: string;
  agent_id: string;
  name: string;
  sites: string[];
  username: string;
  password_enc: Buffer;
  password_length: number;
  totp_enc: Buffer | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

function view(row: LoginRow): LoginView {
  return {
    id: row.id,
    agentId: row.agent_id as LoginView["agentId"],
    name: row.name,
    sites: row.sites,
    username: row.username,
    passwordLength: row.password_length,
    hasTotp: row.totp_enc !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

export class Vault {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly audit: AuditLog,
    private readonly requireAgent?: (agentId: string) => Promise<void>,
  ) {}

  async list(agentId: string): Promise<LoginView[]> {
    await this.requireAgent?.(agentId);
    const rows = await many<LoginRow>(this.db, "select * from logins where agent_id = $1 order by name", [agentId]);
    return rows.map(view);
  }

  private async row(loginId: string): Promise<LoginRow> {
    const row = await maybeOne<LoginRow>(this.db, "select * from logins where id = $1", [loginId]);
    if (!row) throw new HttpError(404, "unknown_login", "No such login.");
    await this.requireAgent?.(row.agent_id);
    return row;
  }

  async get(loginId: string): Promise<LoginView> {
    return view(await this.row(loginId));
  }

  async save(agentId: string, input: { name: string; sites: string[]; username: string; password: string; totp?: string | undefined }): Promise<LoginView> {
    await this.requireAgent?.(agentId);
    const id = randomUUID();
    const sites = loginSites(input.sites);
    const totp = input.totp ? JSON.stringify(parseTotp(input.totp)) : null;
    const row = await one<LoginRow>(
      this.db,
      `insert into logins (id, agent_id, name, sites, username, password_enc, password_length, totp_enc)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        id,
        agentId,
        input.name,
        sites,
        input.username,
        encryptValue(this.key, id, "password", input.password),
        input.password.length,
        totp ? encryptValue(this.key, id, "totp", totp) : null,
      ],
    );
    await this.audit.append(agentId, "owner", "login.added", { loginId: id, name: input.name, sites, totp: totp !== null });
    return view(row);
  }

  async update(
    loginId: string,
    input: { name?: string | undefined; sites?: string[] | undefined; username?: string | undefined; password?: string | undefined; totp?: string | null | undefined },
  ): Promise<LoginView> {
    const current = await this.row(loginId);
    const totp = input.totp === undefined ? current.totp_enc : input.totp === null ? null : encryptValue(this.key, loginId, "totp", JSON.stringify(parseTotp(input.totp)));
    const row = await one<LoginRow>(
      this.db,
      `update logins set name = $2, sites = $3, username = $4, password_enc = $5, password_length = $6, totp_enc = $7, updated_at = now()
       where id = $1 returning *`,
      [
        loginId,
        input.name ?? current.name,
        input.sites !== undefined ? loginSites(input.sites) : current.sites,
        input.username ?? current.username,
        input.password !== undefined ? encryptValue(this.key, loginId, "password", input.password) : current.password_enc,
        input.password !== undefined ? input.password.length : current.password_length,
        totp,
      ],
    );
    await this.audit.append(row.agent_id, "owner", "login.changed", {
      loginId,
      fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
    });
    return view(row);
  }

  async remove(loginId: string): Promise<string> {
    await this.row(loginId);
    const row = await maybeOne<{ agent_id: string; name: string }>(this.db, "delete from logins where id = $1 returning agent_id, name", [loginId]);
    if (!row) throw new HttpError(404, "unknown_login", "No such login.");
    await this.audit.append(row.agent_id, "owner", "login.removed", { loginId, name: row.name });
    return row.agent_id;
  }

  // The value to type, for the browser service only. Never logged, never returned to the model or the owner API.
  async secretFor(agentId: string, loginId: string, field: "username" | "password" | "code"): Promise<{ value: string; sites: string[]; name: string }> {
    const row = await this.row(loginId);
    if (row.agent_id !== agentId) throw new HttpError(404, "unknown_login", "No such login.");
    if (field === "username") return { value: row.username, sites: row.sites, name: row.name };
    if (field === "password") return { value: decryptValue(this.key, row.id, "password", row.password_enc), sites: row.sites, name: row.name };
    if (!row.totp_enc) throw new HttpError(409, "no_totp", `The login "${row.name}" has no 2FA secret. Ask the owner to add it.`);
    const spec = JSON.parse(decryptValue(this.key, row.id, "totp", row.totp_enc)) as TotpSpec;
    return { value: totpCode(spec), sites: row.sites, name: row.name };
  }

  async markUsed(loginId: string): Promise<void> {
    await this.db.query("update logins set last_used_at = now() where id = $1", [loginId]);
  }
}
