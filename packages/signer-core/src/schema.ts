/**
 * The boundary.
 *
 * Every request enters through {@link validateRequest} and nothing past it validates again,
 * so this is the one place a malformed request is stopped and the one place to look when the
 * contract changes. Internal function arguments get types; only untrusted input gets this.
 *
 * What comes out is a deep copy, frozen. The caller keeps its own object and may do what it
 * likes with it; the copy is what the user will be shown and what will be signed, and those
 * two must be the same bytes. Copying at the boundary is what makes that true, and freezing
 * is what keeps it true through every port the copy passes.
 */
import {
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_EVENT_BYTES,
  MAX_EVENT_TAGS,
  MAX_TAG_VALUES,
  ORIGIN_KINDS,
  SIGNER_METHODS,
} from './constants.js';
import { canonicalHttpOrigin } from '@nostr-wot/permissions';
import { SignerError } from './errors.js';
import type {
  EventTemplateInput,
  RequestOrigin,
  SignerMethod,
  SignerRequest,
  ValidatedParams,
  ValidatedRequest,
} from './types.js';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
/** NIP-01: an integer between 0 and 65535. */
const MAX_KIND = 65535;

function invalid(message: string): SignerError {
  return new SignerError('invalid_request', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw invalid(`${what} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, what: string): string {
  const text = requireString(value, what);
  if (text.length === 0) throw invalid(`${what} must not be empty`);
  return text;
}

function requirePubkey(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX_PUBKEY.test(value)) {
    throw invalid(`${what} must be 64 lowercase hex characters`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalid(`${what} must be an integer between 0 and ${max}`);
  }
  return value;
}

/**
 * UTF-8 length counted, not encoded.
 *
 * `TextEncoder` is a declared host requirement of these packages and would give the same
 * number; it is not used here because it would allocate an encoded copy of untrusted input in
 * order to measure it, at the one place whose job is to bound what gets materialised. The
 * character count is checked before this runs, so the input is already known to be small, and
 * counting keeps it that way. Surrogate pairs are one code point of four bytes; a lone
 * surrogate is counted as the three bytes an encoder would emit for U+FFFD.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/**
 * One spelling per caller, so a permission stored for one cannot be dodged by another.
 *
 * A web identifier is one of two things. The first is an http(s) origin, which is what the
 * extension sends (the page's `location.origin`) and what `@nostr-wot/permissions` keys on:
 * its `siteScopes` reads the canonical origin and, underneath it, the bare hostname that older
 * stores used. It is canonicalised by `canonicalHttpOrigin` from that package — scheme and
 * host lowercased, a default port dropped, addresses written one way — and refused when it
 * carries credentials or anything after the authority, so `https://EXAMPLE.COM` and
 * `https://example.com:443` become `https://example.com` while `https://example.com/` and
 * `https://user@example.com` are turned away; `http://` and `https://` stay two keys, and a
 * trailing dot is kept, so `https://example.com.` is its own origin, exactly as a page would
 * report it. The parsing is that package's own, never the host's `URL`: React Native's does
 * not fold case or ports, and a rule that only held under Node's parser held nowhere it
 * mattered.
 *
 * The second is a bare hostname, the legacy key: folded to lowercase, trailing dots removed,
 * because `EXAMPLE.COM` and `example.com.` would otherwise dodge a deny stored for
 * `example.com`. Anything else containing a `:` is refused. The permission key for every
 * other origin kind is `kind:identifier`, so a web caller naming itself `nip55:com.evil.app`
 * would read the grant a real Android package earned; and `localhost:3000` or `[::1]` as bare
 * forms are refused deliberately, since a local development page arrives as
 * `http://localhost:3000` or `http://[::1]:8080`, which the origin form accepts.
 *
 * A NIP-46 client is its hex pubkey and is folded to lowercase for the same reason.
 */
function canonicalIdentifier(kind: RequestOrigin['kind'], identifier: string): string {
  switch (kind) {
    case 'web': {
      const origin = canonicalHttpOrigin(identifier);
      if (origin !== null) return origin;
      if (identifier.includes(':')) {
        throw invalid('origin.identifier for a web origin must be an exact http(s) origin or a bare hostname');
      }
      const host = identifier.toLowerCase().replace(/\.+$/, '');
      if (host.length === 0) throw invalid('origin.identifier must not be empty');
      return host;
    }
    case 'nip46':
      return requirePubkey(identifier.toLowerCase(), 'origin.identifier for a nip46 origin');
    default:
      return identifier;
  }
}

function validateOrigin(value: unknown): RequestOrigin {
  if (!isRecord(value)) throw invalid('origin must be an object');
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(ORIGIN_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`origin.kind must be one of ${ORIGIN_KINDS.join(', ')}`);
  }
  const originKind = kind as RequestOrigin['kind'];
  const origin: RequestOrigin = {
    kind: originKind,
    identifier: canonicalIdentifier(
      originKind,
      requireNonEmptyString(value['identifier'], 'origin.identifier'),
    ),
  };
  if (value['displayName'] !== undefined) {
    origin.displayName = requireString(value['displayName'], 'origin.displayName');
  }
  if (value['icon'] !== undefined) origin.icon = requireString(value['icon'], 'origin.icon');
  return origin;
}

const tooLarge = (): SignerError => invalid(`event is too large: at most ${MAX_EVENT_BYTES} bytes as JSON`);

/**
 * The limits bite BEFORE anything is walked in full, copied or serialised. A caller can hand
 * over a template whose every part is inside its own limit and whose whole is a gigabyte; if
 * the check ran after the copy and the `JSON.stringify`, the copy and the stringify would be
 * the attack. So the content is bounded by its character count first (a character is at
 * least one byte, so a count over the byte limit is already over), and tag bytes are
 * accumulated while the tags are checked, stopping at the first tag that crosses the line.
 * The exact byte measurement afterwards runs only over something already known to be small.
 */
function validateTemplate(value: unknown): EventTemplateInput {
  if (!isRecord(value)) throw invalid('signEvent needs an event template');
  const kind = requireNonNegativeInteger(value['kind'], 'event.kind', MAX_KIND);
  const content = requireString(value['content'], 'event.content');
  if (content.length > MAX_EVENT_BYTES) throw tooLarge();
  const rawTags = value['tags'];
  if (!Array.isArray(rawTags)) throw invalid('event.tags must be an array');
  if (rawTags.length > MAX_EVENT_TAGS) throw invalid(`event.tags may hold at most ${MAX_EVENT_TAGS} tags`);
  let tagBytes = 0;
  for (let index = 0; index < rawTags.length; index++) {
    const tag: unknown = rawTags[index];
    if (!Array.isArray(tag) || tag.length === 0) throw invalid(`event.tags[${index}] must be a non-empty array`);
    if (tag.length > MAX_TAG_VALUES) throw invalid(`event.tags[${index}] may hold at most ${MAX_TAG_VALUES} values`);
    // Brackets, then quotes and a comma per value, then the values themselves.
    tagBytes += 2 + tag.length * 3;
    if (tagBytes > MAX_EVENT_BYTES) throw tooLarge();
    for (const entry of tag as unknown[]) {
      tagBytes += requireString(entry, `event.tags[${index}] values`).length;
      if (tagBytes > MAX_EVENT_BYTES) throw tooLarge();
    }
  }
  // Bounded now, so copying is safe.
  const tags: string[][] = (rawTags as string[][]).map((tag) => [...tag]);
  const event: EventTemplateInput = { kind, content, tags };
  if (value['created_at'] !== undefined) {
    event.created_at = requireNonNegativeInteger(value['created_at'], 'event.created_at');
  }
  if (value['pubkey'] !== undefined) event.pubkey = requirePubkey(value['pubkey'], 'event.pubkey');
  // Measured as the JSON that will be hashed and stored, so the limit means the same thing
  // whatever mix of content and tags a caller chooses.
  if (utf8ByteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw tooLarge();
  return event;
}

function validateParams(method: SignerMethod, raw: Record<string, unknown>): ValidatedParams {
  switch (method) {
    case 'getPublicKey':
    case 'getRelays':
      return { method };
    case 'signEvent':
      return { method, event: validateTemplate(raw['event']) };
    case 'nip04Encrypt':
    case 'nip44Encrypt': {
      const pubkey = requirePubkey(raw['pubkey'], 'pubkey');
      const plaintext = requireString(raw['plaintext'], 'plaintext');
      // Character count first: it is O(1) and a character is at least a byte.
      if (plaintext.length > MAX_CRYPTO_PLAINTEXT_BYTES || utf8ByteLength(plaintext) > MAX_CRYPTO_PLAINTEXT_BYTES) {
        throw invalid(`plaintext may be at most ${MAX_CRYPTO_PLAINTEXT_BYTES} bytes`);
      }
      return { method, pubkey, plaintext };
    }
    case 'nip04Decrypt':
    case 'nip44Decrypt': {
      const pubkey = requirePubkey(raw['pubkey'], 'pubkey');
      const ciphertext = requireNonEmptyString(raw['ciphertext'], 'ciphertext');
      if (ciphertext.length > MAX_CRYPTO_CIPHERTEXT_LENGTH) {
        throw invalid(`ciphertext may be at most ${MAX_CRYPTO_CIPHERTEXT_LENGTH} characters`);
      }
      return { method, pubkey, ciphertext };
    }
  }
}

/** The wire params the frozen request carries for a validated set. Unknown fields are gone. */
function wireParams(params: ValidatedParams): Record<string, unknown> {
  switch (params.method) {
    case 'getPublicKey':
    case 'getRelays':
      return {};
    case 'signEvent':
      return { event: params.event };
    case 'nip04Encrypt':
    case 'nip44Encrypt':
      return { pubkey: params.pubkey, plaintext: params.plaintext };
    case 'nip04Decrypt':
    case 'nip44Decrypt':
      return { pubkey: params.pubkey, ciphertext: params.ciphertext };
  }
}

/**
 * Check a request from any transport and return a frozen copy of it, typed by method.
 *
 * @throws {SignerError} with code `invalid_request` for anything that is not exactly the
 *         contract: a template needs an integer `kind`, a string `content` and an array of
 *         string arrays as `tags`; a pubkey is 64 lowercase hex characters; sizes are bounded.
 */
export function validateRequest(input: unknown): ValidatedRequest {
  try {
    return validate(input);
  } catch (error) {
    // Reading the input is itself untrusted: a getter or a Proxy trap can throw whatever it
    // likes. That is a malformed request, and its text is the caller's, not ours to echo.
    if (error instanceof SignerError) throw error;
    throw invalid('request could not be read');
  }
}

function validate(input: unknown): ValidatedRequest {
  if (!isRecord(input)) throw invalid('request must be an object');
  const id = requireNonEmptyString(input['id'], 'id');
  const origin = validateOrigin(input['origin']);
  const method = input['method'];
  if (typeof method !== 'string' || !(SIGNER_METHODS as readonly string[]).includes(method)) {
    throw invalid(`method must be one of ${SIGNER_METHODS.join(', ')}`);
  }
  const receivedAt = input['receivedAt'];
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) {
    throw invalid('receivedAt must be a finite number');
  }
  const rawParams = input['params'];
  if (!isRecord(rawParams)) throw invalid('params must be an object');

  const params = validateParams(method as SignerMethod, rawParams);
  const request: SignerRequest = {
    id,
    origin,
    method: method as SignerMethod,
    params: wireParams(params),
    receivedAt,
  };
  return { request: deepFreeze(request), params: deepFreeze(params) };
}
