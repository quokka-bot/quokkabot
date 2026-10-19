import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base32Decode, decryptValue, encryptValue, parseTotp, totpCode } from "../src/vault.js";

describe("vault encryption", () => {
  it("round-trips a value and binds it to its login and field", () => {
    const key = randomBytes(32);
    const sealed = encryptValue(key, "login-a", "password", "hunter2");
    expect(sealed.includes(Buffer.from("hunter2"))).toBe(false);
    expect(decryptValue(key, "login-a", "password", sealed)).toBe("hunter2");
    expect(() => decryptValue(key, "login-b", "password", sealed)).toThrow();
    expect(() => decryptValue(key, "login-a", "totp", sealed)).toThrow();
    expect(() => decryptValue(randomBytes(32), "login-a", "password", sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => decryptValue(key, "login-a", "password", tampered)).toThrow();
  });

  it("uses a fresh nonce for every value", () => {
    const key = randomBytes(32);
    expect(encryptValue(key, "x", "password", "same").equals(encryptValue(key, "x", "password", "same"))).toBe(false);
  });
});

describe("TOTP", () => {
  // RFC 6238 appendix B: the SHA1 seed "12345678901234567890", 8 digits.
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches the RFC 6238 test vectors", () => {
    expect(base32Decode(rfcSecret).toString()).toBe("12345678901234567890");
    const spec = { secret: rfcSecret, digits: 8 as const, period: 30, algorithm: "SHA1" as const };
    expect(totpCode(spec, 59_000)).toBe("94287082");
    expect(totpCode(spec, 1_111_111_109_000)).toBe("07081804");
    expect(totpCode(spec, 1_234_567_890_000)).toBe("89005924");
    expect(totpCode(spec, 20_000_000_000_000)).toBe("65353130");
  });

  it("reads a base32 secret as sites show it, and an otpauth link", () => {
    expect(parseTotp("jbsw y3dp ehpk 3pxp")).toEqual({ secret: "JBSWY3DPEHPK3PXP", digits: 6, period: 30, algorithm: "SHA1" });
    expect(parseTotp("otpauth://totp/Roblox:owner?secret=JBSWY3DPEHPK3PXP&issuer=Roblox&digits=8&period=60&algorithm=SHA256")).toEqual({
      secret: "JBSWY3DPEHPK3PXP", digits: 8, period: 60, algorithm: "SHA256",
    });
    expect(() => parseTotp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toThrow(/time-based/);
    expect(() => parseTotp("not base32!")).toThrow(/base32/);
  });
});
