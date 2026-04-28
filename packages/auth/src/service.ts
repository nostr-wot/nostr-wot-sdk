/**
 * `createAuthService` — the high-level entry point. Bundles challenge
 * issuance, signed-event verification, JWT signing, and a JWT verifier
 * into a single object that frameworks plug into.
 */

import type { Event as NostrEvent } from "nostr-tools";
import { issueChallenge, type IssuedChallenge } from "./challenge";
import { verifyAuthEvent, type VerifyFailReason } from "./verify";
import {
  signAuthJwt,
  verifyAuthJwt,
  type AuthJwtPayload,
} from "./jwt";

export interface AuthServiceOptions {
  /** HS256 secret for both challenge HMAC and JWT signing. Required. */
  secret: string;
  /** Challenge TTL in seconds. Default 300 (5 min). */
  challengeTtlSec?: number;
  /** JWT TTL in seconds. Default 7 days. */
  jwtTtlSec?: number;
  /** JWT issuer claim. Optional. */
  jwtIssuer?: string;
  /** JWT audience claim. Optional. */
  jwtAudience?: string;
  /**
   * Allowed clock skew between the server and the client signing the
   * NIP-98 event, in seconds. Default 60.
   */
  skewSec?: number;
  /**
   * If set, the `u` tag on the verify event must equal this URL exactly.
   * Recommended for production to prevent the client from using a
   * verify event signed for a different origin.
   */
  expectedVerifyUrl?: string;
  /**
   * Hook invoked after a successful verify. Use to populate extra
   * claims on the returned JWT (roles, profile, etc.) or persist a
   * server-side session row.
   *
   * Throwing here aborts the login.
   */
  onVerify?: (input: {
    pubkey: string;
    event: NostrEvent;
  }) => Promise<Partial<AuthJwtPayload>> | Partial<AuthJwtPayload> | void;
}

export interface IssueResponse extends IssuedChallenge {}

export interface VerifyResponse {
  /** Compact JWS — opaque to the client, set as Bearer + cookie. */
  jwt: string;
  /** Full payload (server-side use; usually echoed in `/me`). */
  payload: AuthJwtPayload;
}

export type VerifyError =
  | { ok: false; reason: VerifyFailReason | "bad_event" | "hook_rejected"; message?: string };

export interface AuthService {
  issue(): Promise<IssueResponse>;
  verify(event: NostrEvent): Promise<VerifyResponse | VerifyError>;
  verifyJwt(token: string): Promise<AuthJwtPayload | null>;
  options: Required<Pick<AuthServiceOptions, "challengeTtlSec" | "jwtTtlSec">> &
    AuthServiceOptions;
}

export function createAuthService(opts: AuthServiceOptions): AuthService {
  const challengeTtlSec = opts.challengeTtlSec ?? 300;
  const jwtTtlSec = opts.jwtTtlSec ?? 7 * 24 * 3600;

  return {
    options: { ...opts, challengeTtlSec, jwtTtlSec },

    async issue() {
      return issueChallenge(opts.secret, challengeTtlSec);
    },

    async verify(event) {
      try {
        const result = await verifyAuthEvent(event, {
          secret: opts.secret,
          challengeTtlSec,
          ...(opts.skewSec !== undefined ? { skewSec: opts.skewSec } : {}),
          ...(opts.expectedVerifyUrl
            ? { expectedUrl: opts.expectedVerifyUrl, expectedMethod: "POST" }
            : {}),
        });
        if (!result.ok) return { ok: false, reason: result.reason };

        let extra: Partial<AuthJwtPayload> | void;
        try {
          extra = opts.onVerify
            ? await opts.onVerify({ pubkey: result.pubkey, event })
            : undefined;
        } catch (err) {
          return {
            ok: false,
            reason: "hook_rejected",
            message: err instanceof Error ? err.message : String(err),
          };
        }

        const payload: AuthJwtPayload = {
          pubkey: result.pubkey,
          ...(extra ?? {}),
        };
        const jwt = await signAuthJwt(payload, {
          secret: opts.secret,
          ttlSec: jwtTtlSec,
          ...(opts.jwtIssuer ? { issuer: opts.jwtIssuer } : {}),
          ...(opts.jwtAudience ? { audience: opts.jwtAudience } : {}),
        });
        return { jwt, payload };
      } catch (err) {
        return {
          ok: false,
          reason: "bad_event",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async verifyJwt(token) {
      return verifyAuthJwt(token, {
        secret: opts.secret,
        ...(opts.jwtIssuer ? { issuer: opts.jwtIssuer } : {}),
        ...(opts.jwtAudience ? { audience: opts.jwtAudience } : {}),
      });
    },
  };
}
