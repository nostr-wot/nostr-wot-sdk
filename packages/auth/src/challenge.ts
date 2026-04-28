/**
 * Stateless HMAC challenges.
 *
 * Format: `<base64url(nonce16 || timestamp_be64)>.<base64url(HMAC_SHA256(secret, payload))>`
 *
 * The server holds only `secret`. To verify a returned challenge, recompute
 * the HMAC and compare in constant time, then check the timestamp against
 * the configured TTL. No DB, no Redis, no per-instance state.
 *
 * Replay protection: relies on TTL + the client-side challenge being
 * single-use *in practice* (the kind-27235 event includes `created_at`
 * which the server can also check). For strict no-replay guarantees,
 * inject a `consume`-style store via `verifyChallenge`'s `onUse` hook.
 */

const NONCE_BYTES = 16;
const TIMESTAMP_BYTES = 8;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64u: string): Uint8Array {
  const pad = b64u.length % 4 === 0 ? 0 : 4 - (b64u.length % 4);
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function writeUInt64BE(value: number, out: Uint8Array, offset: number): void {
  // Safe up to 2^53 - JS Number precision; far enough into the future
  // that we don't care about the upper bytes for unix-seconds use.
  for (let i = TIMESTAMP_BYTES - 1; i >= 0; i--) {
    out[offset + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

function readUInt64BE(buf: Uint8Array, offset: number): number {
  let v = 0;
  for (let i = 0; i < TIMESTAMP_BYTES; i++) v = v * 256 + buf[offset + i]!;
  return v;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i]! ^ b[i]!;
  return acc === 0;
}

export interface IssuedChallenge {
  /** The challenge string the client signs and sends back. */
  challenge: string;
  /** Unix seconds when this challenge stops being valid. */
  expiresAt: number;
}

export async function issueChallenge(
  secret: string,
  ttlSec: number,
): Promise<IssuedChallenge> {
  const payload = new Uint8Array(NONCE_BYTES + TIMESTAMP_BYTES);
  crypto.getRandomValues(payload.subarray(0, NONCE_BYTES));
  const issuedAt = Math.floor(Date.now() / 1000);
  writeUInt64BE(issuedAt, payload, NONCE_BYTES);
  const sig = await hmac(secret, payload);
  return {
    challenge: `${bytesToBase64Url(payload)}.${bytesToBase64Url(sig)}`,
    expiresAt: issuedAt + ttlSec,
  };
}

export interface ChallengeVerifyResult {
  ok: boolean;
  reason?: "malformed" | "bad_mac" | "expired";
  /** Unix seconds when the challenge was issued. */
  issuedAt?: number;
}

export async function verifyChallenge(
  challenge: string,
  secret: string,
  ttlSec: number,
): Promise<ChallengeVerifyResult> {
  const parts = challenge.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  let payload: Uint8Array;
  let sig: Uint8Array;
  try {
    payload = base64UrlToBytes(parts[0]!);
    sig = base64UrlToBytes(parts[1]!);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.length !== NONCE_BYTES + TIMESTAMP_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(expected, sig)) return { ok: false, reason: "bad_mac" };
  const issuedAt = readUInt64BE(payload, NONCE_BYTES);
  const now = Math.floor(Date.now() / 1000);
  if (now - issuedAt > ttlSec) return { ok: false, reason: "expired", issuedAt };
  return { ok: true, issuedAt };
}
