// ─── TOTP (RFC 6238) helpers ────────────────────────────────────────
// Wraps otplib with the app's policy decisions:
//   * epochTolerance: 30s (v12 `window: 1`) — accept ±1 30s step to absorb clock skew
//     between the server and the operator's phone.
//   * Recovery codes are 10 single-use codes in xxxxx-xxxxx format,
//     stored as sha256 hashes (the codes carry ~40 bits of entropy, far
//     beyond online-guessing reach, and sha256 keeps verification O(1)
//     instead of bcrypt's deliberate slowness — these are not passwords).

import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";


export function generateTotpSecret(): string {
  return generateSecret(); // base32
}

export function buildOtpauthUrl(username: string, secret: string): string {
  return generateURI({ issuer: "SSH Commander", label: username, secret });
}

export async function buildQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    // 30s tolerance = ±1 time step — the v12 `window: 1` policy.
    return verifySync({ secret, token: clean, epochTolerance: 30 }).valid;
  } catch {
    return false;
  }
}

// ─── Recovery codes ─────────────────────────────────────────────────

function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    hashes.push(hashRecoveryCode(code));
  }
  return { codes, hashes };
}

/**
 * Try to consume a recovery code. Returns the remaining hashes if the code
 * matched (caller persists the shrunken array — single use), null otherwise.
 */
export function consumeRecoveryCode(storedHashes: string[], input: string): string[] | null {
  const h = hashRecoveryCode(input);
  const idx = storedHashes.indexOf(h);
  if (idx === -1) return null;
  return [...storedHashes.slice(0, idx), ...storedHashes.slice(idx + 1)];
}

/** A recovery code looks like xxxxx-xxxxx (10 hex chars); a TOTP code is 6 digits. */
export function looksLikeRecoveryCode(input: string): boolean {
  return normalizeRecoveryCode(input).length === 10;
}
