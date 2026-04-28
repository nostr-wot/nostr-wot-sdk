/**
 * Web Standard handlers — `(req: Request) => Promise<Response>`.
 *
 * Mount in any framework that speaks Request/Response: Next.js App
 * Router, Hono, Bun, Deno, Cloudflare Workers, etc.
 *
 * Returns a `{ challenge, verify, me, logout }` set; pass `cookie: true`
 * (default) to also set/clear an `HttpOnly` JWT cookie alongside the
 * JSON body. Set `cookie: false` for header-only flows (apps that want
 * to manage the JWT in localStorage / Authorization header themselves).
 */

import type { Event as NostrEvent } from "nostr-tools";
import type { AuthService } from "./service";
import type { AuthJwtPayload } from "./jwt";

export interface AuthHandlerOptions {
  /** Issue + clear an `HttpOnly` JWT cookie. Default true. */
  cookie?: boolean;
  /** Cookie name. Default `nw_auth`. */
  cookieName?: string;
  /** Additional cookie attrs (Path, Domain, SameSite). */
  cookieAttrs?: {
    path?: string;
    domain?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  };
}

export interface AuthHandlers {
  /** GET or POST → returns `{ challenge, expiresAt }`. */
  challenge: (req: Request) => Promise<Response>;
  /** POST signed kind-27235 event → returns `{ jwt, pubkey }` + cookie. */
  verify: (req: Request) => Promise<Response>;
  /** GET with cookie/Authorization → returns the JWT payload. */
  me: (req: Request) => Promise<Response>;
  /** POST → clears the cookie. Pure header op; no DB. */
  logout: (req: Request) => Promise<Response>;
  /** Read the JWT from cookies/Authorization header. Helpful for app code. */
  readJwt: (req: Request) => Promise<AuthJwtPayload | null>;
  /** Build a Set-Cookie header for the JWT. Exposed for custom flows. */
  buildSetCookie: (jwt: string) => string;
  /** Build a Set-Cookie header that clears the JWT cookie. */
  buildClearCookie: () => string;
}

const DEFAULT_COOKIE = "nw_auth";

function ok<T>(data: T, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function err(status: number, body: object | string): Response {
  return new Response(JSON.stringify(typeof body === "string" ? { error: body } : body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    if (p.slice(0, idx) === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

function readBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]! : null;
}

export function createHandlers(
  service: AuthService,
  opts: AuthHandlerOptions = {},
): AuthHandlers {
  const useCookie = opts.cookie ?? true;
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE;
  const cookieAttrs = opts.cookieAttrs ?? {};
  const path = cookieAttrs.path ?? "/";
  const domain = cookieAttrs.domain ? `; Domain=${cookieAttrs.domain}` : "";
  const sameSite = cookieAttrs.sameSite ?? "Lax";
  const secure = cookieAttrs.secure ?? sameSite === "None";

  const buildSetCookie = (jwt: string) => {
    const maxAge = service.options.jwtTtlSec;
    return [
      `${cookieName}=${encodeURIComponent(jwt)}`,
      `Path=${path}`,
      domain.replace(/^; /, ""),
      `Max-Age=${maxAge}`,
      `SameSite=${sameSite}`,
      "HttpOnly",
      secure ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");
  };

  const buildClearCookie = () => {
    return [
      `${cookieName}=`,
      `Path=${path}`,
      domain.replace(/^; /, ""),
      "Max-Age=0",
      `SameSite=${sameSite}`,
      "HttpOnly",
      secure ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");
  };

  const readJwt = async (req: Request): Promise<AuthJwtPayload | null> => {
    const fromHeader = readBearer(req);
    const fromCookie = useCookie ? readCookie(req, cookieName) : null;
    const token = fromHeader ?? fromCookie;
    if (!token) return null;
    return service.verifyJwt(token);
  };

  return {
    buildSetCookie,
    buildClearCookie,
    readJwt,

    async challenge() {
      const res = await service.issue();
      return ok(res);
    },

    async verify(req) {
      let event: NostrEvent;
      try {
        const body = await req.json();
        event = body && typeof body === "object" && "event" in body ? body.event : body;
      } catch {
        return err(400, "invalid_json");
      }
      const result = await service.verify(event);
      if (!("jwt" in result)) {
        return err(401, { error: result.reason, message: result.message });
      }
      const headers: Record<string, string> = {};
      if (useCookie) headers["Set-Cookie"] = buildSetCookie(result.jwt);
      return ok({ jwt: result.jwt, pubkey: result.payload.pubkey }, headers);
    },

    async me(req) {
      const payload = await readJwt(req);
      if (!payload) return err(401, "unauthorized");
      return ok(payload);
    },

    async logout() {
      const headers: Record<string, string> = {};
      if (useCookie) headers["Set-Cookie"] = buildClearCookie();
      return ok({ ok: true }, headers);
    },
  };
}
