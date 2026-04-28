# @nostr-wot/auth

Drop-in Nostr authentication for HTTP servers. Stateless HMAC challenge → NIP-98 (kind 27235) signed-event verify → JWT. Mount four route handlers, get login.

| Entry | What's in it |
|---|---|
| `@nostr-wot/auth` | `createAuthService`, `createHandlers` (Web standard), low-level challenge/verify/JWT primitives |
| `@nostr-wot/auth/next` | `createNextHandlers` — Next.js App Router shim |
| `@nostr-wot/auth/client` | `loginWithSigner`, `fetchMe`, `logout` — drives the full flow on the client |

## Why

You don't want email + password on a Nostr app. NIP-98 lets clients prove ownership of a pubkey by signing a server-issued challenge. This package implements the server side: issue, verify, JWT. Stateless by default — no DB, no Redis, no per-instance memory.

## Install

```bash
npm i @nostr-wot/auth nostr-tools
```

## Quick start (Next.js App Router)

### 1. Create the service

```ts
// lib/auth.ts
import { createAuthService } from "@nostr-wot/auth";
import { createNextHandlers } from "@nostr-wot/auth/next";

export const auth = createAuthService({
  secret: process.env.NOSTR_AUTH_SECRET!,    // 32+ random bytes; HMAC + JWT
  challengeTtlSec: 300,                       // 5 min
  jwtTtlSec: 60 * 60 * 24 * 7,               // 1 week
  jwtIssuer: "https://myapp.com",
  expectedVerifyUrl: "https://myapp.com/api/auth/verify",
  // Optional: hook into a successful verify to add custom claims or
  // create/lookup a user row in your DB.
  async onVerify({ pubkey }) {
    const user = await db.user.upsert(pubkey);
    return { uid: user.id, role: user.role };
  },
});

export const handlers = createNextHandlers(auth, {
  cookie: true,                  // also set/clear the JWT as an HttpOnly cookie
  cookieName: "myapp_auth",      // default "nw_auth"
  cookieAttrs: { sameSite: "Lax", secure: true },
});
```

### 2. Mount the routes

```ts
// app/api/auth/challenge/route.ts
import { handlers } from "@/lib/auth";
export const POST = handlers.challenge;
```

```ts
// app/api/auth/verify/route.ts
import { handlers } from "@/lib/auth";
export const POST = handlers.verify;
```

```ts
// app/api/auth/me/route.ts
import { handlers } from "@/lib/auth";
export const GET = handlers.me;
```

```ts
// app/api/auth/logout/route.ts
import { handlers } from "@/lib/auth";
export const POST = handlers.logout;
```

That's it. Four files. `<5min` of work.

### 3. Drive the flow from the client

```ts
import { loginWithSigner, fetchMe, logout } from "@nostr-wot/auth/client";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const { jwt, pubkey } = await loginWithSigner({
  baseUrl: "/api/auth",
  signer,
});
// Cookie is now set; subsequent fetches with `credentials: 'include'` work.

const me = await fetchMe({ baseUrl: "/api/auth" });
// → { pubkey, uid, role, iat, exp, ... }

await logout({ baseUrl: "/api/auth" });
```

## How it works

1. **Challenge** — server generates a random 16-byte nonce, packs it with a unix timestamp, HMAC-SHA256s the whole thing with `secret`. Returns `<base64url(payload)>.<base64url(hmac)>`. **No state.**
2. **Verify** — client signs a kind-27235 (NIP-98) event with `["challenge", "<the-string>"]`, `["u", "<verify-url>"]`, `["method", "POST"]`. Server verifies the signature with `nostr-tools`, recomputes the HMAC, checks the timestamp against the TTL, validates `u`/`method` if configured, then issues a JWT.
3. **JWT** — HS256-signed via [`jose`](https://github.com/panva/jose), claims include `pubkey` (subject) + anything `onVerify` returns. Optionally set as an `HttpOnly` cookie.
4. **`/me`** — reads the JWT off `Authorization: Bearer …` or the cookie, returns the payload.
5. **`/logout`** — clears the cookie. Pure header op.

The kind-27235 standard is **NIP-98** (HTTP Auth). This package extends it with a `challenge` tag for replay-resistance.

## Security notes

- **Secret rotation.** When you change `secret`, all existing JWTs and pending challenges become invalid. Plan for it.
- **Challenge TTL.** Default 5 minutes. Long enough for users to fumble through a hardware key prompt; short enough that a leaked challenge expires fast.
- **Skew tolerance.** `created_at` on the signed event is checked within ±60s by default — tunable via `skewSec`. Tighten in lockstep with your server's clock guarantees.
- **`expectedVerifyUrl`.** Strongly recommended in production. Without it, a client could reuse a verify event signed for a *different* origin (e.g. an attacker's site).
- **Cookie flags.** Defaults: `HttpOnly`, `SameSite=Lax`, `Path=/`. `Secure` toggles on automatically when `SameSite=None`. For cross-subdomain flows, set `cookieAttrs.domain`.
- **Replay protection.** The default flow is single-use *in practice* — the challenge string is freshly generated per call and the kind-27235 event includes a unique `created_at`. For strict no-replay guarantees (e.g. seeding the JWT from a queue worker), wire a per-challenge consume-once store via a wrapper around `verifyChallenge`.

## Custom claims via `onVerify`

```ts
createAuthService({
  secret: process.env.NOSTR_AUTH_SECRET!,
  async onVerify({ pubkey, event }) {
    const user = await db.users.findUnique({ where: { pubkey } });
    if (!user || user.banned) throw new Error("forbidden");
    return {
      uid: user.id,
      role: user.role,
      tier: user.tier,
    };
  },
});
```

The returned object is merged into the JWT payload. Throwing aborts the login (returns 401 with `reason: "hook_rejected"`).

## Reading the JWT in server code

For RSC or server actions:

```ts
// app/dashboard/page.tsx (server component)
import { handlers } from "@/lib/auth";
import { headers } from "next/headers";

export default async function Dashboard() {
  const headerList = await headers();
  const req = new Request("http://x", { headers: headerList });
  const payload = await handlers.readJwt(req);
  if (!payload) redirect("/login");
  return <h1>Welcome {payload.pubkey}</h1>;
}
```

For middleware:

```ts
// middleware.ts
import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function middleware(req: Request) {
  const cookie = req.headers.get("cookie")?.match(/nw_auth=([^;]+)/)?.[1];
  const payload = cookie ? await auth.verifyJwt(decodeURIComponent(cookie)) : null;
  if (!payload) return NextResponse.redirect("/login");
}
```

## Other frameworks

`createHandlers` returns Web-standard `(req: Request) => Promise<Response>` functions. Mount in:

- **Hono** — `app.post("/auth/challenge", (c) => handlers.challenge(c.req.raw))`
- **Bun.serve** — `if (url.pathname === "/auth/challenge") return handlers.challenge(req)`
- **Cloudflare Workers** — same as above
- **Deno** — `Deno.serve(handlers.challenge)`

## Lower-level primitives

For when you need to plug into a custom flow:

```ts
import {
  issueChallenge,
  verifyChallenge,
  verifyAuthEvent,
  signAuthJwt,
  verifyAuthJwt,
} from "@nostr-wot/auth";

const { challenge, expiresAt } = await issueChallenge(secret, 300);
const result = await verifyChallenge(challenge, secret, 300);
// → { ok, reason?, issuedAt? }

const verifyResult = await verifyAuthEvent(signedEvent, {
  secret,
  challengeTtlSec: 300,
  expectedUrl: "https://myapp.com/api/auth/verify",
  expectedMethod: "POST",
});

const jwt = await signAuthJwt({ pubkey, role: "admin" }, { secret });
const payload = await verifyAuthJwt(jwt, { secret });
```

## License

MIT
