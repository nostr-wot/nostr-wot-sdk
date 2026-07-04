# @nostr-wot/auth

## 3.0.0

### Patch Changes

- Updated dependencies [[`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e)]:
  - @nostr-wot/signers@1.0.0

## 2.0.0

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.4.0

## 1.0.0

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.3.0

## 0.2.0

### Minor Changes

- New package `@nostr-wot/auth` — drop-in Nostr authentication for HTTP servers.

  - Stateless HMAC challenge → NIP-98 (kind 27235) signed-event verify → JWT (HS256 via `jose`). No DB, no Redis, no per-instance state.
  - `createAuthService({ secret, challengeTtlSec, jwtTtlSec, jwtIssuer?, expectedVerifyUrl?, onVerify? })` — high-level entry. `onVerify` hook lets you populate custom JWT claims or persist a server-side user row.
  - `createHandlers(service, opts?)` — Web-standard `(req: Request) => Promise<Response>` handlers (`challenge`, `verify`, `me`, `logout`). Plugs into Next.js App Router, Hono, Bun, Cloudflare Workers, Deno.
  - `createNextHandlers(service, opts?)` from `@nostr-wot/auth/next` — same handlers wrapped for Next.js App Router route files.
  - Optional `HttpOnly` JWT cookie alongside the JSON body. Configurable name, domain, sameSite, secure.
  - `@nostr-wot/auth/client`: `loginWithSigner({ baseUrl, signer })`, `fetchMe`, `logout` — drives the full flow from the browser using any NostrSigner.
  - Lower-level primitives exported: `issueChallenge`, `verifyChallenge`, `verifyAuthEvent`, `signAuthJwt`, `verifyAuthJwt`.
