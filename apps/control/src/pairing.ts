import { randomInt } from "node:crypto";
import { sha256Hex } from "@quokkabot/shared/node";
import type { AuditLog } from "./audit.js";
import { type PhoneSignInRoute, insertPhoneSession } from "./auth.js";
import { type Db, one, withTx } from "./db.js";
import { CODE_ALPHABET } from "./desktop.js";
import { HttpError } from "./errors.js";

// Codes the server's operator prints with `pairing-code`, for signing a phone in without a browser: a server nobody
// opens in a browser, or the App Review server. A code works a set number of times until it expires or is revoked.
// Twelve characters from the unambiguous alphabet (about 59 bits): out of reach of guessing at the sign-in rate limit.
export const MAX_CODE_USES = 20;
export const MAX_CODE_DAYS = 30;

export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < 12; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

// The code as stored: its hash, over the twelve characters without dashes.
export function pairingCodeHash(code: string): string {
  return sha256Hex(`pairing-code:${code.toUpperCase().replace(/[\s-]/g, "")}`);
}

export class PairingCodes {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly agentIds: () => string[] | Promise<string[]>,
  ) {}

  async create(uses: number, days: number): Promise<{ code: string; expiresAt: string }> {
    if (!Number.isInteger(uses) || uses < 1 || uses > MAX_CODE_USES) throw new Error(`--uses must be 1 to ${MAX_CODE_USES}`);
    if (!Number.isInteger(days) || days < 1 || days > MAX_CODE_DAYS) throw new Error(`--days must be 1 to ${MAX_CODE_DAYS}`);
    const code = newPairingCode();
    const row = await one<{ expires_at: Date }>(
      this.db,
      "insert into pairing_codes (hash, uses_left, expires_at) values ($1, $2, now() + $3::interval) returning expires_at",
      [pairingCodeHash(code), uses, `${days} days`],
    );
    for (const agentId of await this.agentIds()) {
      await this.audit.append(agentId, "system", "owner.pairing_code_created", { uses, days });
    }
    return { code, expiresAt: row.expires_at.toISOString() };
  }

  // One use of the code and the phone session it buys, in one transaction: concurrent uses of a code with one use
  // left make one session.
  async redeem(code: string, deviceName: string): Promise<string> {
    const hash = pairingCodeHash(code);
    const token = await withTx(this.db, async (tx) => {
      const used = await tx.query(
        "update pairing_codes set uses_left = uses_left - 1 where hash = $1 and uses_left > 0 and expires_at > now() and revoked_at is null",
        [hash],
      );
      if (used.rowCount !== 1) throw new HttpError(403, "code_invalid", "This code is wrong, used up or expired. Make a new one on the server.");
      return insertPhoneSession(tx, deviceName, hash);
    });
    for (const agentId of await this.agentIds()) {
      await this.audit.append(agentId, "owner", "owner.signed_in", { device: deviceName, through: "code" satisfies PhoneSignInRoute });
    }
    return token;
  }
}
