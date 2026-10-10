/**
 * Authentication events, and the one thing that makes them different from every other event a
 * site asks to have signed: they name a DESTINATION.
 *
 * A kind-1 note goes wherever the caller sends it and says nothing about who may read it. A
 * kind-22242 (NIP-42) or kind-27235 (NIP-98) event is a CREDENTIAL, addressed to the relay or
 * HTTP service named in its `relay` or `u` tag. So "may this site sign kind 22242?" is the
 * wrong question, and answering it `allow` hands the site a credential for every relay it
 * names from then on. That is GHSA-vx4h-56qj-wcp7, and a downstream app had to work around it
 * by refusing kind 22242 outright on any silent path.
 *
 * The right question has three parts: which protocol, which destination, which account. This
 * module is the pure half of asking it — parse the event, validate it, and say what it is
 * addressed to. {@link AuthenticationGrants} is the stored half.
 *
 * ## Why this lives in `@nostr-wot/permissions` and not in `@nostr-wot/signer-core`
 *
 * It parses events, which reads like signer-core's job, and signer-core is where the request
 * pipeline lives. Three reasons it is here anyway:
 *
 * 1. **The grant store cannot be anywhere else.** A destination-scoped grant is a permission,
 *    so it belongs in the permission package, and it needs {@link AuthenticationRequest} and
 *    {@link validAuthenticationScope} to do its job. `signer-core` already depends on
 *    `permissions`, so putting the parser there and the store here is an import cycle.
 * 2. **The destination is an origin, and this package already owns the one spelling of an
 *    origin.** `scope.ts` exists because a rule stored for `https://example.com` must not be
 *    dodged by `https://EXAMPLE.COM`. A destination-keyed grant needs exactly that property
 *    for exactly that reason, off the same code, and it gets it here for free.
 * 3. **It costs no dependency.** The event is taken structurally ({@link
 *    AuthenticationEventInput}), so this package still depends on nothing but
 *    `@nostr-wot/storage`, and a host can validate an authentication event without pulling in
 *    a signer.
 *
 * ## Why it does not use `URL`
 *
 * The extension's version calls `new URL()`. This package must not: React Native's `URL`
 * implements `origin`, `protocol` and `hostname` as regex slices of the input, with no
 * lowercasing and no default-port folding, so on the phone `https://RELAY.TEST:443` and
 * `wss://relay.test` are distinct destinations and the `requester.origin !== origin` check
 * passes anything. `scope.ts` spells out the whole argument. Every rejection the extension's
 * version makes is made here, off this package's own origin grammar instead.
 *
 * One deliberate difference follows from that, and it is in the safe direction: a NIP-42
 * destination keeps its path and query VERBATIM rather than resolved the way `URL.href` would
 * resolve them, so `wss://relay.test/a/../b` and `wss://relay.test/b` are two destinations
 * here and one under `URL`. Verbatim can only ever SPLIT a grant key, never merge two, so the
 * cost is an extra approval prompt and never an unintended credential. Merging is the failure
 * that would matter.
 *
 * ## Where this came from
 *
 * Ported from the extension's `src/domain/signing/authentication.ts`, which on the
 * extension's current main still carries `parseAuthentication`, `authenticationKey`
 * (keyed on protocol, exact signed URL and method), `validAuthenticationScope`
 * (`connected-sites` only for NIP-42) and the `AuthenticationGrant` record. The storage
 * half lives in its `src/services/permissions/authentication.ts`.
 *
 * The upstream commits were `6db46fa` ("Bind Nostr authentication permissions to
 * destinations and accounts") and `ecac8ae` ("Simplify authentication review and remember
 * scoped rejections"). Both are kept here as provenance only and neither resolves from the
 * extension's main any more, which was squashed and force-rewritten. The files above are
 * the reference.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/42.md NIP-42
 * @see https://github.com/nostr-protocol/nips/blob/master/98.md NIP-98
 */
import { NIP42_KIND, NIP98_KIND } from './constants.js';
import { canonicalHttpOrigin, canonicalWebSocketOrigin, hostnameOf } from './scope.js';

/** Explicit host policy for nonstandard website login. Empty by default. */
export interface AuthenticationParserOptions {
  legacyLoginOrigins?: readonly string[];
}

/** Which authentication protocol an event speaks. */
export type AuthenticationProtocol = 'nip42' | 'nip98' | 'legacy-login';

/**
 * How widely a consent applies.
 *
 * - `once` — this one event, no stored record at all.
 * - `site` — this requesting origin, this account, this destination (and method, for NIP-98).
 * - `connected-sites` — this destination for EVERY connected site, NIP-42 only. A relay is
 *   shared infrastructure that many clients legitimately connect to on a user's behalf; an
 *   HTTP service is not, so {@link validAuthenticationScope} refuses this for NIP-98.
 */
export type AuthenticationScope = 'once' | 'site' | 'connected-sites';

/**
 * The parts of an event {@link parseAuthentication} reads.
 *
 * Structural rather than a `nostr-tools` type, so this package keeps its single dependency.
 * Anything with these four fields satisfies it, including an `UnsignedEvent`.
 */
export interface AuthenticationEventInput {
  kind: number;
  content: string;
  created_at: number;
  tags: readonly (readonly string[])[];
}

/** A validated authentication event, reduced to what a consent decision is made against. */
export interface AuthenticationRequest {
  protocol: AuthenticationProtocol;
  /**
   * The destination EXACTLY as signed: what the approval screen shows, and, for NIP-98, what a
   * remembered consent is keyed by, query bytes included. Canonicalisation is for the
   * destination ORIGIN only; the user is shown, and bound to, the string the site wrote.
   */
  url: string;
  /**
   * The canonical destination: the relay's `scheme://host[:port]/path` for NIP-42, which is
   * what a NIP-42 grant is keyed by, and the service's ORIGIN for NIP-98, which is what a
   * NIP-98 grant displays while {@link url} is what it is keyed by.
   */
  destination: string;
  /** The HTTP method, for NIP-98 only. Part of the grant key: a `GET` consent is not a `DELETE` one. */
  method?: string;
  /**
   * Whether the destination is somewhere other than the requesting origin. Always true for
   * NIP-42, because a relay is never the page.
   */
  crossOrigin: boolean;
}

/**
 * One stored consent.
 *
 * `origin` is the requesting site, or `*` for a `connected-sites` NIP-42 grant. `decision`
 * absent means allow, which is what records written before rejections were rememberable look
 * like.
 */
export interface AuthenticationGrant {
  /** Missing on legacy records means allow. */
  decision?: 'allow' | 'deny';
  id: string;
  accountId: string;
  origin: string;
  protocol: AuthenticationProtocol;
  /** The destination origin, kept for display on every record whatever its version. */
  destination: string;
  method?: string;
  /**
   * {@link ENDPOINT_GRANT_VERSION} on a NIP-98 record: this grant binds {@link resource}, the
   * exact signed URL, and not merely the destination origin. Absent on a NIP-42 record, which
   * is keyed by the canonical relay URL in `destination` and needs no second field, and absent
   * on a NIP-98 record written before endpoint scoping existed.
   */
  version?: typeof ENDPOINT_GRANT_VERSION;
  /** The exact signed URL a v2 NIP-98 grant is for, query bytes included. */
  resource?: string;
}

/**
 * The version marking a NIP-98 grant as bound to one endpoint rather than to an origin.
 *
 * An origin-wide HTTP consent is much broader than what a user was shown: they approved
 * `POST https://api.example/login` and it answered `POST https://api.example/transfer` just as
 * well. So a NIP-98 grant now records the exact signed URL, and a record without this version
 * is a LEGACY one whose `allow` is never honoured again: its holder is asked once more, at the
 * narrower scope, and the record stays visible and revocable rather than being silently
 * upgraded into an endpoint consent nobody gave. A legacy DENY keeps its broad reach, because
 * narrowing a refusal is the one direction that loses protection.
 *
 * From the extension, which spells the same rule out inline rather than as a constant: its
 * `AuthenticationGrant.version?: 2` in `src/domain/signing/authentication.ts`, and
 * `matchesGrant` in `src/services/permissions/authentication.ts`, which honours an HTTP
 * grant only on `grant.version === 2 && typeof grant.resource === 'string'` and otherwise
 * falls through to `grant.decision === 'deny'`. A reader opening those files will find no
 * `ENDPOINT_GRANT_VERSION`; the name is this package's.
 */
export const ENDPOINT_GRANT_VERSION = 2;

/**
 * NIP-42's window is wider than NIP-98's because a relay challenge is answered over a
 * connection that may have been open for a while, whereas an HTTP token is minted per request.
 * Both numbers are the extension's; an event outside the window is refused rather than shown,
 * so a token captured from an old session cannot be replayed through a prompt.
 */
const NIP42_MAX_AGE_SECONDS = 600;
const NIP98_MAX_AGE_SECONDS = 60;

/**
 * The only hosts allowed to speak plain `http:` or `ws:`, either as the requester or as the
 * destination. Everywhere else a credential must not cross the network in the clear.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** RFC 9110 `token`, uppercase only: a method is a case-sensitive token and ours are canonical. */
const HTTP_METHOD = /^[0-9A-Z!#$%&'*+.^_`|~-]+$/;

/**
 * Tag names by which a caller may state its own origin. Checked for agreement with the
 * browser-derived origin, never trusted in place of it.
 */
const ORIGIN_METADATA_TAGS = ['origin', 'client-origin'];

/** NIP-98's `payload` tag is a SHA-256 of the request body, lowercase hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `scheme://` and the authority, split from whatever follows, without parsing it. */
const URL_SHAPE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?]*)([/?][\s\S]*)?$/;

/**
 * The one value of a tag that must appear exactly once, or an error.
 *
 * Competing tags are refused rather than resolved. Two `u` tags is not a malformed event to be
 * tidied up; it is a site asking the user to authenticate to one destination while the signer
 * reads another, and there is no reading of it that a person could be asked to approve.
 */
function tag(event: AuthenticationEventInput, name: string): string {
  const values = event.tags?.filter((item) => item[0] === name);
  if (!values || values.length !== 1 || values[0].length !== 2 || !values[0][1]) {
    throw new Error(`Invalid authentication ${name} tag`);
  }
  return values[0][1]!;
}

/** Whether a canonical origin's host is a loopback address. */
function isLoopback(canonical: string): boolean {
  return LOOPBACK_HOSTS.includes(hostnameOf(canonical));
}

/**
 * The canonical destination of `raw`, and its origin, or null when anything about it is
 * unacceptable.
 *
 * Null rather than a reason, because every one of these is reported to the caller as the same
 * `Invalid authentication destination`: a site that wrote a credentials-bearing address with a
 * fragment in it does not need to be told which half was refused, and neither does the user.
 */
function destinationOf(
  raw: string,
  requesterOrigin: string,
  relay: boolean,
): { origin: string; full: string } | null {
  // Checked on the raw STRING, before any parsing, because these are properties of what was
  // signed and not of what a parser makes of it. A URL parser normalises several of them away.
  if (raw !== raw.trim()) return null;
  // A fragment is never sent to the server, so a destination carrying one shows the user a
  // string that differs from what the request will reach.
  if (raw.includes('#')) return null;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    // Control characters and the backslash: header-splitting material, and a backslash is a
    // path separator to some servers and a literal to others, so the string a person read is
    // not reliably the resource that gets hit.
    if (code <= 32 || code === 127 || char === '\\') return null;
  }

  // The requesting origin must already BE its canonical spelling. A host that hands us
  // `https://EXAMPLE.COM` has not resolved the caller's identity, it has passed a string
  // through, and every grant keyed on it would be a second permission key for one site.
  const requester = canonicalHttpOrigin(requesterOrigin);
  if (requester === null || requester !== requesterOrigin) return null;
  if (requester.startsWith('http://') && !isLoopback(requester)) return null;

  const shape = URL_SHAPE.exec(raw);
  if (!shape) return null;
  const scheme = shape[1]!.toLowerCase();

  // The scheme set is enforced by WHICH canonicaliser is asked, and only there: a NIP-42 event
  // naming `https:` and a NIP-98 event naming `wss:` both come back null. There is deliberately
  // no second scheme check in front of this, because a redundant one would be a line no test
  // can turn red, and a guard nothing can falsify is a claim rather than a defence.
  const authority = `${scheme}://${shape[2]!}`;
  const origin = relay ? canonicalWebSocketOrigin(authority) : canonicalHttpOrigin(authority);
  if (origin === null) return null;
  // Plain `ws:` / `http:` reach a loopback host and nowhere else.
  const insecure = relay ? 'ws' : 'http';
  if (scheme === insecure && !isLoopback(origin)) return null;

  // An absent path is `/`, as `URL` would render it, so `wss://relay.test` and
  // `wss://relay.test/` are one destination rather than two. Beyond that the tail is kept
  // verbatim: see the module note on why splitting is safe and merging would not be.
  const tail = shape[3] ?? '';
  return { origin, full: origin + (tail.startsWith('/') ? tail : `/${tail}`) };
}

/**
 * What this event is asking to authenticate to, or `undefined` when it is not an
 * authentication event at all.
 *
 * `undefined` and a throw mean different things and callers depend on the difference:
 * `undefined` is "an ordinary event, decide it the ordinary way", a throw is "an authentication
 * event that cannot be approved by anyone". Nothing here returns a request it is unsure about.
 *
 * Call it AGAIN after any await that the user was in the middle of, before signing: the
 * timestamp window is part of validity, so a prompt or an unlock that took long enough can
 * outlive the token that was shown.
 *
 * @param event - the event a caller asked to have signed
 * @param origin - the requesting site, in its canonical spelling; anything else is refused
 * @param now - seconds since the epoch, injectable for tests
 * @throws when the event is an authentication event and anything about it is invalid
 */
export function parseAuthentication(
  event: AuthenticationEventInput,
  origin: string,
  now: number = Math.floor(Date.now() / 1000),
  options: AuthenticationParserOptions = {},
): AuthenticationRequest | undefined {
  if (event.kind !== NIP98_KIND && event.kind !== NIP42_KIND) return undefined;
  const relay = event.kind === NIP42_KIND;
  // A caller may state which origin it believes it is. That is metadata and never evidence:
  // the browser-derived origin is the only authenticated statement of who is asking, and
  // nothing here is relaxed because a tag agrees with it. What a tag must not do is CONTRADICT
  // it, because then one of the two strings is being shown to a user or sent to a server while
  // the other is being authorised, and the event would be signed with both in it. `tag` also
  // refuses two of them, so a matching tag beside a lying one is not a way through.
  // The extension's `parseAuthentication` in `src/domain/signing/authentication.ts` runs the
  // same loop over `['origin', 'client-origin']` and throws the same way.
  for (const name of ORIGIN_METADATA_TAGS) {
    if (event.tags?.some((item) => item[0] === name) && tag(event, name) !== origin) {
      throw new Error(`Invalid authentication ${name} tag`);
    }
  }
  if (relay && !event.tags.some(item => item[0] === 'relay') && event.tags.some(item => item[0] === 'domain')) {
    if (!options.legacyLoginOrigins?.includes(origin) || canonicalHttpOrigin(origin) !== origin
      || !origin.startsWith('https://') || tag(event, 'domain') !== hostnameOf(origin)
      || event.tags.some(item => !['domain', 'challenge', 'origin', 'client-origin'].includes(item[0]!))) {
      throw new Error('Invalid legacy authentication domain or format');
    }
    if (!tag(event, 'challenge').trim()) throw new Error('Invalid authentication challenge tag');
    if (!Number.isInteger(event.created_at) || Math.abs(now - event.created_at) > NIP98_MAX_AGE_SECONDS) {
      throw new Error('Invalid authentication timestamp');
    }
    if (event.content !== '') throw new Error('Invalid authentication content');
    return { protocol: 'legacy-login', url: origin, destination: origin, crossOrigin: false };
  }
  const raw = tag(event, relay ? 'relay' : 'u');

  const destination = destinationOf(raw, origin, relay);
  // The extension words this "Invalid authentication URL". Renamed for one reason: the shared
  // packages' platform-boundary scan (`packages/vault/test/boundaries.test.ts`) forbids the token
  // it used, in string literals too, and its documented remedy for a false positive is a rename
  // rather than an exemption. "destination" is the more accurate word in any case, since a
  // refused REQUESTER origin lands here as well. Both the extension's own assertions and this
  // package's match on `authentication`, so no consumer sees a different class of failure.
  if (destination === null) throw new Error('Invalid authentication destination');

  const maxAge = relay ? NIP42_MAX_AGE_SECONDS : NIP98_MAX_AGE_SECONDS;
  if (!Number.isInteger(event.created_at) || Math.abs(now - event.created_at) > maxAge) {
    throw new Error('Invalid authentication timestamp');
  }
  // Both NIPs specify an empty content. Anything in there is a payload riding inside a
  // credential the user is being shown as a destination and a method.
  if (event.content !== '') throw new Error('Invalid authentication content');

  if (relay) {
    // Present and unambiguous, though its value is the relay's to check, not ours.
    tag(event, 'challenge');
    return { protocol: 'nip42', url: raw, destination: destination.full, crossOrigin: true };
  }

  const method = tag(event, 'method');
  if (!HTTP_METHOD.test(method)) throw new Error('Invalid authentication HTTP method');
  const payloads = (event.tags ?? []).filter((item) => item[0] === 'payload');
  if (
    payloads.length &&
    (payloads.length !== 1 || payloads[0]!.length !== 2 || !SHA256_HEX.test(payloads[0]![1]!))
  ) {
    throw new Error('Invalid authentication payload tag');
  }
  return {
    protocol: 'nip98',
    url: raw,
    destination: destination.origin,
    method,
    crossOrigin: destination.origin !== origin,
  };
}

/**
 * The key that groups pending requests for review, and it groups nothing across destinations.
 *
 * A signer that batches "approve all of these at once" must batch only requests that are the
 * same decision. The exact signed URL and method are in the key for that reason: two requests
 * to two relays are two decisions however similar they look in a list.
 */
export function authenticationKey(auth: AuthenticationRequest): string {
  return JSON.stringify([auth.protocol, auth.url, auth.method ?? '']);
}

/**
 * Whether `scope` is one a user could have chosen for THIS request.
 *
 * A type guard, so a host that reads a scope off a message cannot pass it on unchecked.
 * `connected-sites` is NIP-42 only: sharing an HTTP credential across every connected site is
 * not a consent this model offers, so it is refused here rather than filtered in a UI.
 */
export function validAuthenticationScope(
  auth: AuthenticationRequest,
  scope: unknown,
): scope is AuthenticationScope {
  if (auth.protocol === 'legacy-login') return scope === 'once';
  return (
    scope === 'once' || scope === 'site' || (scope === 'connected-sites' && auth.protocol === 'nip42')
  );
}
