// A software passkey for tests: an ES256 key pair stored in the passkeys table and real WebAuthn assertions signed with
// it, so the server's verification path runs unchanged.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type pg from "pg";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export class SoftPasskey {
  readonly id = b64url(randomBytes(16));
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {}

  // COSE_Key for EC2 P-256 (kty 2, alg -7, crv 1, x, y), CBOR-encoded by hand.
  cosePublicKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]);
  }

  async register(db: pg.Pool): Promise<void> {
    await db.query("insert into passkeys (id, public_key, counter, transports) values ($1, $2, 0, '{internal}') on conflict do nothing", [
      this.id,
      this.cosePublicKey(),
    ]);
  }

  // A registration response ("none" attestation) for registration options returned by the server.
  attest(options: { challenge: string }): Record<string, unknown> {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const flags = Buffer.from([0x45]); // user present, user verified, attested credential data
    const credentialId = Buffer.from(this.id, "base64url");
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([rpIdHash, flags, Buffer.alloc(4), Buffer.alloc(16), idLength, credentialId, this.cosePublicKey()]);
    const authDataLength = Buffer.alloc(2);
    authDataLength.writeUInt16BE(authData.length);
    // CBOR map {fmt: "none", attStmt: {}, authData}, encoded by hand.
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3, 0x63]), Buffer.from("fmt"), Buffer.from([0x64]), Buffer.from("none"),
      Buffer.from([0x67]), Buffer.from("attStmt"), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from("authData"), Buffer.from([0x59]), authDataLength, authData,
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { attestationObject: b64url(attestationObject), clientDataJSON: b64url(clientDataJSON), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  // An assertion for authentication options returned by the server, made on `origin` (this passkey's own by default).
  assert(options: { challenge: string }, origin = this.origin): Record<string, unknown> {
    this.counter += 1;
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const flags = Buffer.from([0x05]); // user present and user verified
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([rpIdHash, flags, count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) },
      clientExtensionResults: {},
    };
  }
}
