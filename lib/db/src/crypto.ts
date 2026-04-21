// ─── Credential encryption at rest ─────────────────────────────────
// AES-256-GCM symmetric encryption for sensitive credential columns
// (sshPassword, enablePassword on routers + credential_profiles).
//
// Wire format of encrypted values:
//
//   enc:v1:<base64(iv || authTag || ciphertext)>
//
// where iv is 12 bytes (GCM standard), authTag is 16 bytes, and the
// remainder is the ciphertext. The `enc:v1:` prefix is the version
// marker we sniff on read so a row written before the upgrade (raw
// plaintext) still decrypts as itself — we lazily re-encrypt on the
// next write.
//
// The master key is read from CREDENTIAL_ENCRYPTION_KEY (hex or base64,
// either 32 raw bytes encoded). In production we refuse to start
// without one. In development we derive a deterministic dev-only key
// from a fixed string and warn loudly so an operator who copies a dev
// dump into prod gets a startup error instead of silently-decryptable
// secrets.
//
// Threat model addressed:
//   * Database dump leak (backup, replica snapshot, dev clone) no
//     longer exposes the device passwords directly.
//   * An operator with read-only DB access cannot recover the
//     plaintext without also obtaining CREDENTIAL_ENCRYPTION_KEY,
//     which lives in the deployment env / secret store rather than
//     the DB.
//
// Threat model NOT addressed (by design — would need an HSM or KMS):
//   * An attacker with code execution on the API server can decrypt
//     anything, because the process necessarily holds the key in
//     memory to talk SSH. That's the same trust boundary as before.

import crypto from "crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (raw && raw.length > 0) {
    // Accept hex (64 chars) or base64 (any length that decodes to 32 bytes).
    let buf: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      buf = Buffer.from(raw, "hex");
    } else {
      try { buf = Buffer.from(raw, "base64"); } catch { buf = Buffer.alloc(0); }
    }
    if (buf.length !== 32) {
      throw new Error(
        "CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes " +
        "(64 hex chars or 44-char base64). Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    return buf;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is required in production. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "and persist it in your deployment secret store. Losing this key permanently bricks every stored device password.",
    );
  }
  // Dev fallback: deterministic key so developers don't need to set the
  // env var to run locally, but loud-warned so it's never used in prod.
  // We derive from a known label + the DATABASE_URL so two devs on
  // different DBs don't accidentally share a key.
  console.warn(
    "[crypto] CREDENTIAL_ENCRYPTION_KEY not set — using dev-only derived key. " +
    "DO NOT use this in production. Generated values written to your dev DB " +
    "WILL NOT decrypt under a different DATABASE_URL or in production.",
  );
  return crypto.createHash("sha256")
    .update("ssh-commander-dev-only-credential-key:" + (process.env.DATABASE_URL ?? ""))
    .digest();
}

let _key: Buffer | null = null;
function key(): Buffer {
  if (!_key) _key = loadKey();
  return _key;
}

/**
 * True if the value bears the encryption prefix. Used to distinguish a
 * legacy plaintext row (written before this module existed) from an
 * encrypted one during the gradual migration window.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret. Returns null for null/undefined/empty input so the
 * column stays NULL when there's no secret to store. Idempotent: an
 * already-encrypted value passes through unchanged so callers can
 * encrypt-on-write without checking first.
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a secret. Pass-through for unencrypted (legacy plaintext)
 * values so the read path keeps working until the migration script
 * (or the next write) re-encrypts the row. Throws on malformed or
 * tampered ciphertext (auth tag mismatch) — that's the GCM guarantee.
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value === "" ? null : value;
  const blob = Buffer.from(value.slice(PREFIX.length), "base64");
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Encrypted credential is malformed (too short)");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
