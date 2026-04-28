/**
 * Verify a signed kind-27235 (NIP-98) authentication event against an
 * issued challenge.
 *
 * The event is expected to carry:
 *   - `["challenge", "<challenge-string>"]` — required
 *   - `["u", "<request-url>"]` — optional, validated against `expectedUrl`
 *     when provided
 *   - `["method", "POST"]` — optional, validated when provided
 *
 * `created_at` is checked against the configured skew (default ±60s).
 */

import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { verifyChallenge, type ChallengeVerifyResult } from "./challenge";

export interface AuthEventVerifyOptions {
  /** Challenge HMAC secret. Same one used by `issueChallenge`. */
  secret: string;
  /** Challenge TTL (seconds). Default 300. */
  challengeTtlSec?: number;
  /** Allowed clock skew on the event's `created_at` (seconds). Default 60. */
  skewSec?: number;
  /** Validate the `u` tag against this exact URL. Skip when undefined. */
  expectedUrl?: string;
  /** Validate the `method` tag (case-insensitive). Skip when undefined. */
  expectedMethod?: string;
  /** Reject events with kind != this. Default 27235 (NIP-98). */
  expectedKind?: number;
}

export type VerifyFailReason =
  | "bad_signature"
  | "bad_kind"
  | "bad_skew"
  | "missing_challenge"
  | "challenge_invalid"
  | "url_mismatch"
  | "method_mismatch";

export type AuthEventVerifyResult =
  | { ok: true; pubkey: string; createdAt: number; challenge: ChallengeVerifyResult }
  | { ok: false; reason: VerifyFailReason };

export async function verifyAuthEvent(
  event: NostrEvent,
  opts: AuthEventVerifyOptions,
): Promise<AuthEventVerifyResult> {
  const skew = opts.skewSec ?? 60;
  const challengeTtl = opts.challengeTtlSec ?? 300;
  const expectedKind = opts.expectedKind ?? 27235;

  if (!verifyEvent(event)) return { ok: false, reason: "bad_signature" };
  if (event.kind !== expectedKind) return { ok: false, reason: "bad_kind" };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > skew) {
    return { ok: false, reason: "bad_skew" };
  }

  const challengeTag = event.tags.find((t) => t[0] === "challenge");
  if (!challengeTag || typeof challengeTag[1] !== "string") {
    return { ok: false, reason: "missing_challenge" };
  }
  const challenge = await verifyChallenge(
    challengeTag[1],
    opts.secret,
    challengeTtl,
  );
  if (!challenge.ok) return { ok: false, reason: "challenge_invalid" };

  if (opts.expectedUrl) {
    const uTag = event.tags.find((t) => t[0] === "u");
    if (!uTag || uTag[1] !== opts.expectedUrl) {
      return { ok: false, reason: "url_mismatch" };
    }
  }
  if (opts.expectedMethod) {
    const mTag = event.tags.find((t) => t[0] === "method");
    if (
      !mTag ||
      typeof mTag[1] !== "string" ||
      mTag[1].toUpperCase() !== opts.expectedMethod.toUpperCase()
    ) {
      return { ok: false, reason: "method_mismatch" };
    }
  }

  return { ok: true, pubkey: event.pubkey, createdAt: event.created_at, challenge };
}
