/**
 * Next.js App Router shim. App Router route handlers receive a Web
 * `Request` and return a Web `Response`, so the framework-agnostic
 * `createHandlers` already plugs in directly. This module is a tiny
 * convenience wrapper that names them in a Next-friendly way.
 */

import type { AuthService } from "./service";
import {
  createHandlers,
  type AuthHandlerOptions,
  type AuthHandlers,
} from "./handlers";

export type NextRouteHandler = (
  req: Request,
  ctx?: { params?: Record<string, string | string[]> },
) => Promise<Response>;

export interface NextHandlers {
  /** Mount as `app/api/auth/challenge/route.ts` → `export const POST = handlers.challenge` */
  challenge: NextRouteHandler;
  /** Mount as `app/api/auth/verify/route.ts` → `export const POST = handlers.verify` */
  verify: NextRouteHandler;
  /** Mount as `app/api/auth/me/route.ts` → `export const GET = handlers.me` */
  me: NextRouteHandler;
  /** Mount as `app/api/auth/logout/route.ts` → `export const POST = handlers.logout` */
  logout: NextRouteHandler;
  /** Read the JWT off a request (server components, middleware). */
  readJwt: AuthHandlers["readJwt"];
  /** Build a Set-Cookie string (for advanced flows). */
  buildSetCookie: AuthHandlers["buildSetCookie"];
  /** Build a Set-Cookie clear string (for advanced flows). */
  buildClearCookie: AuthHandlers["buildClearCookie"];
}

export function createNextHandlers(
  service: AuthService,
  opts: AuthHandlerOptions = {},
): NextHandlers {
  const h = createHandlers(service, opts);
  // Wrap so each handler ignores the optional Next ctx arg cleanly
  const wrap =
    (fn: (req: Request) => Promise<Response>): NextRouteHandler =>
    (req) =>
      fn(req);

  return {
    challenge: wrap(h.challenge),
    verify: wrap(h.verify),
    me: wrap(h.me),
    logout: wrap(h.logout),
    readJwt: h.readJwt,
    buildSetCookie: h.buildSetCookie,
    buildClearCookie: h.buildClearCookie,
  };
}
