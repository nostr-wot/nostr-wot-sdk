/**
 * JWT signing + verification via `jose`.
 *
 * Default algorithm: HS256 with the same secret used for the challenge
 * HMAC. For multi-instance deploys with key rotation or asymmetric
 * verification, configure `jwtAlg` + provide your own keys.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface AuthJwtPayload extends JWTPayload {
  /** Signed-in user's hex pubkey. */
  pubkey: string;
  /** Auth method (informational). */
  method?: string;
  /** Free-form claims the app may attach. */
  [k: string]: unknown;
}

export interface JwtOptions {
  /** Secret string (HS256) — same secret used for challenge HMAC works fine. */
  secret: string;
  /** Issuer — e.g. "https://myapp.com". Optional. */
  issuer?: string;
  /** Audience. Optional. */
  audience?: string;
  /** TTL in seconds. Default 7 days. */
  ttlSec?: number;
}

export async function signAuthJwt(
  claims: AuthJwtPayload,
  opts: JwtOptions,
): Promise<string> {
  const ttl = opts.ttlSec ?? 7 * 24 * 3600;
  const key = new TextEncoder().encode(opts.secret);
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setSubject(claims.pubkey);
  if (opts.issuer) jwt = jwt.setIssuer(opts.issuer);
  if (opts.audience) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(key);
}

export async function verifyAuthJwt(
  token: string,
  opts: JwtOptions,
): Promise<AuthJwtPayload | null> {
  try {
    const key = new TextEncoder().encode(opts.secret);
    const { payload } = await jwtVerify(token, key, {
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      ...(opts.audience ? { audience: opts.audience } : {}),
      algorithms: ["HS256"],
    });
    if (typeof payload.pubkey !== "string") return null;
    return payload as AuthJwtPayload;
  } catch {
    return null;
  }
}
