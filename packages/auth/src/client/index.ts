/**
 * Client-side helper that drives the full challenge/verify/JWT flow.
 *
 * Usage:
 *   const { jwt, pubkey } = await loginWithSigner({
 *     baseUrl: "/api/auth",        // mount point of the server handlers
 *     signer,                       // any NostrSigner
 *   });
 *
 * Cookie-based servers (default): the JWT is set automatically; you can
 * ignore the returned `jwt` and rely on the cookie. Header-based flows:
 * persist `jwt` (e.g. localStorage) and send `Authorization: Bearer …`
 * on subsequent requests.
 */

import type { Event as NostrEvent, EventTemplate } from "nostr-tools";

export interface LoginSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

export interface LoginOptions {
  /** Base URL where the server handlers are mounted (e.g. "/api/auth"). */
  baseUrl: string;
  /** NostrSigner-shaped object. `@nostr-wot/signers` instances qualify. */
  signer: LoginSigner;
  /** `fetch` impl (defaults to global). */
  fetch?: typeof fetch;
  /** Send credentials with cross-origin requests. Default "include" so the
   *  HttpOnly cookie set by the server flows back. */
  credentials?: RequestCredentials;
  /** Override the event kind. Default 27235 (NIP-98). */
  kind?: number;
  /** Override the verify URL written into the `u` tag. */
  verifyUrl?: string;
}

export interface LoginResult {
  jwt: string;
  pubkey: string;
}

export async function fetchChallenge(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  credentials: RequestCredentials = "include",
): Promise<{ challenge: string; expiresAt: number }> {
  const r = await fetchImpl(`${baseUrl}/challenge`, {
    method: "POST",
    credentials,
  });
  if (!r.ok) throw new Error(`challenge: HTTP ${r.status}`);
  return r.json();
}

export async function buildAuthEvent(
  signer: LoginSigner,
  challenge: string,
  verifyUrl: string,
  kind = 27235,
): Promise<NostrEvent> {
  const template: EventTemplate = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["u", verifyUrl],
      ["method", "POST"],
    ],
    content: "",
  };
  return signer.signEvent(template);
}

export async function loginWithSigner(opts: LoginOptions): Promise<LoginResult> {
  const fetchImpl = opts.fetch ?? fetch;
  const credentials = opts.credentials ?? "include";
  const verifyUrl = opts.verifyUrl ?? `${opts.baseUrl}/verify`;
  const kind = opts.kind ?? 27235;

  const { challenge } = await fetchChallenge(opts.baseUrl, fetchImpl, credentials);
  const event = await buildAuthEvent(opts.signer, challenge, verifyUrl, kind);
  const r = await fetchImpl(verifyUrl, {
    method: "POST",
    credentials,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`verify: HTTP ${r.status} ${text}`);
  }
  return (await r.json()) as LoginResult;
}

export async function fetchMe<T = unknown>(opts: {
  baseUrl: string;
  jwt?: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
}): Promise<T | null> {
  const fetchImpl = opts.fetch ?? fetch;
  const r = await fetchImpl(`${opts.baseUrl}/me`, {
    method: "GET",
    credentials: opts.credentials ?? "include",
    headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {},
  });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

export async function logout(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
}): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  await fetchImpl(`${opts.baseUrl}/logout`, {
    method: "POST",
    credentials: opts.credentials ?? "include",
  });
}
