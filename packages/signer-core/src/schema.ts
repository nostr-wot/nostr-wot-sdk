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
  KEY_METHODS,
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_EVENT_BYTES,
  MAX_EVENT_TAGS,
  MAX_ORIGIN_DISPLAY_NAME_LENGTH,
  MAX_ORIGIN_ICON_LENGTH,
  MAX_ORIGIN_IDENTIFIER_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_TAG_VALUES,
  ORIGIN_KINDS,
  RECIPIENT_KEM_KEY_LENGTH,
  SIGNER_METHODS,
} from './constants.js';
import { canonicalHostname, canonicalHttpOrigin } from '@nostr-wot/permissions';
import { classifyEnvelope } from '@nostr-wot/pq';
import { SignerError } from './errors.js';
import type {
  EventTemplateInput,
  PreparedParams,
  RequestOrigin,
  SignerBatchItem,
  SignerBatchRequest,
  SignerMethod,
  SignerRequest,
  ValidatedBatch,
  ValidatedBatchItem,
  ValidatedParams,
  ValidatedRequest,
} from './types.js';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
/** Standard base64, padding at the end only; what a `kind:10203` carries. */
const BASE64 = /^[A-Za-z0-9+/]+=*$/;
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

/**
 * A string no longer than `max` characters, checked by `.length` before it is read any
 * further: the envelope fields are persisted verbatim on every request, so the bound is the
 * first thing that happens to them and the error names the limit, never the value.
 */
function requireBoundedString(value: unknown, what: string, max: number): string {
  const text = requireString(value, what);
  if (text.length > max) throw invalid(`${what} may be at most ${max} characters`);
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
 * The second is a bare hostname, the legacy key, canonicalised by `canonicalHostname` from
 * the same package: folded to lowercase, trailing dots removed, an IPv4 address written one
 * way, because `EXAMPLE.COM`, `example.com.` and `127.1` would otherwise dodge a deny stored
 * for the canonical spelling. Anything that is not a hostname — a path, credentials,
 * whitespace, a `:` — is refused rather than becoming its own key. The permission key for
 * every other origin kind is `kind:identifier`, so a web caller naming itself
 * `nip55:com.evil.app` would read the grant a real Android package earned; and
 * `localhost:3000` or `[::1]` as bare forms are refused deliberately, since a local
 * development page arrives as `http://localhost:3000` or `http://[::1]:8080`, which the
 * origin form accepts.
 *
 * A NIP-46 client is its hex pubkey and is folded to lowercase for the same reason.
 */
function canonicalIdentifier(kind: RequestOrigin['kind'], identifier: string): string {
  switch (kind) {
    case 'web': {
      const origin = canonicalHttpOrigin(identifier);
      if (origin !== null) return origin;
      const host = canonicalHostname(identifier);
      // `location.origin` is the string "null" for a sandboxed iframe, a data: page and, in
      // Chrome, a file:// page. Every such page reports the same one, so a bucket keyed on it
      // is shared by all of them and one remembered allow covers every one. There is no
      // identity to grant to, so there is no grant: refused, rather than given a bucket that
      // cannot tell them apart. The extension inherits the shared bucket; raised against it.
      if (host === 'null') throw invalid('origin.identifier is an opaque origin (null) and cannot hold permissions');
      if (host !== null) return host;
      if (identifier.replace(/\.+$/, '').length === 0) throw invalid('origin.identifier must not be empty');
      throw invalid('origin.identifier for a web origin must be an exact http(s) origin or a bare hostname');
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
  // Bounded first, before canonicalisation reads a character of it.
  const identifier = requireBoundedString(value['identifier'], 'origin.identifier', MAX_ORIGIN_IDENTIFIER_LENGTH);
  const origin: RequestOrigin = {
    kind: originKind,
    identifier: canonicalIdentifier(originKind, requireNonEmptyString(identifier, 'origin.identifier')),
  };
  if (value['displayName'] !== undefined) {
    origin.displayName = requireBoundedString(value['displayName'], 'origin.displayName', MAX_ORIGIN_DISPLAY_NAME_LENGTH);
  }
  if (value['icon'] !== undefined) {
    origin.icon = requireBoundedString(value['icon'], 'origin.icon', MAX_ORIGIN_ICON_LENGTH);
  }
  return origin;
}

const eventTooLarge = (): SignerError => invalid(`event is too large: at most ${MAX_EVENT_BYTES} bytes as JSON`);
const batchTooLarge = (): SignerError => invalid(`batch is too large: at most ${MAX_BATCH_BYTES} bytes as JSON across every item`);

/**
 * The limits bite BEFORE anything is walked in full, copied or serialised. A caller can hand
 * over a template whose every part is inside its own limit and whose whole is a gigabyte; if
 * the check ran after the copy and the `JSON.stringify`, the copy and the stringify would be
 * the attack. So the content is bounded by its character count first (a character is at
 * least one byte, so a count over the byte limit is already over), and tag bytes are
 * accumulated while the tags are checked, stopping at the first tag that crosses the line.
 * The exact byte measurement afterwards runs only over something already known to be small.
 *
 * `limit` is the per-event cap, or less: inside a batch it is whatever of the batch budget
 * is left, so the aggregate cap bites on exactly the same checks, before the crossing item
 * is walked. `tooLarge` names which of the two was hit. Returns the exact byte count with
 * the template, so a batch can charge it against the budget.
 */
function validateTemplate(value: unknown, limit: number, tooLarge: () => SignerError): { event: EventTemplateInput; bytes: number } {
  if (!isRecord(value)) throw invalid('signEvent needs an event template');
  const kind = requireNonNegativeInteger(value['kind'], 'event.kind', MAX_KIND);
  const content = requireString(value['content'], 'event.content');
  if (content.length > limit) throw tooLarge();
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
    if (tagBytes > limit) throw tooLarge();
    for (const entry of tag as unknown[]) {
      tagBytes += requireString(entry, `event.tags[${index}] values`).length;
      if (tagBytes > limit) throw tooLarge();
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
  const bytes = utf8ByteLength(JSON.stringify(event));
  if (bytes > limit) throw tooLarge();
  return { event, bytes };
}

/** Validated params and what they weigh against a batch budget, in the unit each limit uses. */
interface MeasuredParams {
  params: ValidatedParams;
  bytes: number;
}

/**
 * `budget` is what a batch has left; a single request has no budget and gets each method's
 * own limit. Inside a batch the effective limit is the smaller of the two, and when it is the
 * budget that is hit, the error says the batch is too large rather than the item.
 */
/**
 * The post-quantum opt-in on `nip44Encrypt`, as the extension validates it: `opts` is either
 * absent (classic) or exactly `{ scheme: 'pq', recipientKemKey }` with a key that is 2092
 * base64 characters, the length of an ML-KEM-1024 key, checked before a character of it is
 * scanned. Any other spelling is refused rather than folded into classic, because a caller
 * that asked for post-quantum and got NIP-44 back could not tell.
 */
function validateEncryptScheme(raw: Record<string, unknown>): { scheme: 'classic' } | { scheme: 'pq'; recipientKemKey: string } {
  const opts = raw['opts'];
  if (opts === undefined) return { scheme: 'classic' };
  if (!isRecord(opts)) throw invalid('opts must be an object');
  if (opts['scheme'] !== 'pq') throw invalid('opts.scheme must be pq');
  const key = opts['recipientKemKey'];
  if (typeof key !== 'string') throw invalid('opts.recipientKemKey must be a string');
  if (key.length !== RECIPIENT_KEM_KEY_LENGTH) {
    throw invalid(`opts.recipientKemKey must be ${RECIPIENT_KEM_KEY_LENGTH} base64 characters`);
  }
  if (!BASE64.test(key)) throw invalid('opts.recipientKemKey must be base64');
  return { scheme: 'pq', recipientKemKey: key };
}

function validateParams(method: SignerMethod, raw: Record<string, unknown>, budget = Infinity): MeasuredParams {
  switch (method) {
    case 'getPublicKey':
    case 'getRelays':
      return { params: { method }, bytes: 0 };
    case 'signPqAttestation':
      // The event is entirely the account's: its own keys, its own proof of possession.
      // A caller that hands over a template is asking for something this method does not
      // do, and is told so rather than having the template silently ignored.
      if (Object.keys(raw).length > 0) throw invalid('signPqAttestation takes no params');
      return { params: { method }, bytes: 0 };
    case 'signEvent': {
      const limit = Math.min(MAX_EVENT_BYTES, budget);
      const { event, bytes } = validateTemplate(raw['event'], limit, limit < MAX_EVENT_BYTES ? batchTooLarge : eventTooLarge);
      return { params: { method, event }, bytes };
    }
    case 'nip04Encrypt':
    case 'nip44Encrypt': {
      const pubkey = requirePubkey(raw['pubkey'], 'pubkey');
      const plaintext = requireString(raw['plaintext'], 'plaintext');
      const limit = Math.min(MAX_CRYPTO_PLAINTEXT_BYTES, budget);
      const tooLarge = (): SignerError =>
        limit < MAX_CRYPTO_PLAINTEXT_BYTES ? batchTooLarge() : invalid(`plaintext may be at most ${MAX_CRYPTO_PLAINTEXT_BYTES} bytes`);
      // Character count first: it is O(1) and a character is at least a byte.
      if (plaintext.length > limit) throw tooLarge();
      const bytes = utf8ByteLength(plaintext);
      if (bytes > limit) throw tooLarge();
      if (method === 'nip04Encrypt') {
        if (raw['opts'] !== undefined) throw invalid('opts are only supported for nip44Encrypt');
        return { params: { method, pubkey, plaintext }, bytes };
      }
      const scheme = validateEncryptScheme(raw);
      // The recipient's key is held with the request; a batch is charged for it.
      return { params: { method, pubkey, plaintext, ...scheme }, bytes: bytes + (scheme.scheme === 'pq' ? RECIPIENT_KEM_KEY_LENGTH : 0) };
    }
    case 'nip04Decrypt':
    case 'nip44Decrypt': {
      const pubkey = requirePubkey(raw['pubkey'], 'pubkey');
      const ciphertext = requireNonEmptyString(raw['ciphertext'], 'ciphertext');
      const limit = Math.min(MAX_CRYPTO_CIPHERTEXT_LENGTH, budget);
      if (ciphertext.length > limit) {
        throw limit < MAX_CRYPTO_CIPHERTEXT_LENGTH
          ? batchTooLarge()
          : invalid(`ciphertext may be at most ${MAX_CRYPTO_CIPHERTEXT_LENGTH} characters`);
      }
      if (method === 'nip04Decrypt') return { params: { method, pubkey, ciphertext }, bytes: ciphertext.length };
      // The payload is self-describing (a version byte and an algorithm byte), so the route
      // is decided here, once, and every consumer of the typed params sees which it is. A
      // payload whose header names our envelope and which cannot be opened is post-quantum and
      // unreadable, never classic: it is not refused here, because a request that reached the
      // boundary cleanly belongs in the activity log with an honest reason, and `invalid_request`
      // would leave no entry at all.
      const verdict = classifyEnvelope(ciphertext);
      if (verdict === 'classic') return { params: { method, pubkey, ciphertext, scheme: 'classic' }, bytes: ciphertext.length };
      return {
        params: { method, pubkey, ciphertext, scheme: 'pq', envelope: verdict === 'pq' ? 'hybrid' : 'unreadable' },
        bytes: ciphertext.length,
      };
    }
  }
}

/** The wire params the frozen request carries for a validated set. Unknown fields are gone. */
function wireParams(params: ValidatedParams): Record<string, unknown> {
  switch (params.method) {
    case 'getPublicKey':
    case 'getRelays':
    case 'signPqAttestation':
      return {};
    case 'signEvent':
      return { event: params.event };
    case 'nip04Encrypt':
      return { pubkey: params.pubkey, plaintext: params.plaintext };
    case 'nip44Encrypt':
      // The opt-in travels with the frozen request, so the prompt can say "post-quantum".
      return params.scheme === 'pq'
        ? { pubkey: params.pubkey, plaintext: params.plaintext, opts: { scheme: 'pq', recipientKemKey: params.recipientKemKey } }
        : { pubkey: params.pubkey, plaintext: params.plaintext };
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
  const id = requireNonEmptyString(requireBoundedString(input['id'], 'id', MAX_REQUEST_ID_LENGTH), 'id');
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

  const { params } = validateParams(method as SignerMethod, rawParams);
  const request: SignerRequest = {
    id,
    origin,
    method: method as SignerMethod,
    params: wireParams(params),
    receivedAt,
  };
  return { request: deepFreeze(request), params: deepFreeze(params) };
}

/**
 * The request the prompt is shown, once an attestation's event has been built.
 *
 * `signPqAttestation` reaches the boundary with no params, because everything in the event is
 * the account's: its own post-quantum keys, its own proof of possession. Presenting that as it
 * arrived would hand the host a method name and an empty object, which is a button, not a
 * decision. So the built `kind:10203` is disclosed here as the `signEvent` it is, frozen, and
 * an existing event preview renders it with no case of its own. Any other method is returned
 * unchanged — it is already exactly what will be signed.
 */
export function disclosedRequest(request: SignerRequest, prepared: PreparedParams): SignerRequest {
  if (prepared.method !== 'signPqAttestation') return request;
  return deepFreeze({
    id: request.id,
    origin: request.origin,
    method: 'signEvent' as const,
    params: { event: prepared.event },
    receivedAt: request.receivedAt,
  });
}

/** The same for a batch: every attestation item spelled as the `signEvent` it is. */
export function disclosedBatch(batch: SignerBatchRequest, prepared: readonly PreparedParams[]): SignerBatchRequest {
  if (!prepared.some((params) => params.method === 'signPqAttestation')) return batch;
  return deepFreeze({
    id: batch.id,
    origin: batch.origin,
    items: batch.items.map((item, index) => {
      const params = prepared[index];
      if (params?.method !== 'signPqAttestation') return item;
      return { id: item.id, method: 'signEvent' as const, params: { event: params.event } };
    }),
    receivedAt: batch.receivedAt,
  });
}

/**
 * Check a batch from any transport and return a frozen copy of it, typed per item.
 *
 * The count is checked before a single item is read, and the byte budget is charged item by
 * item so the item that crosses it is refused before its tags are walked: a batch whose every
 * item is legal on its own and whose whole is not stops at the first item that does not fit,
 * with everything before it, by construction, inside the budget.
 *
 * @throws {SignerError} with code `invalid_request`, naming the item by index.
 */
export function validateBatchRequest(input: unknown): ValidatedBatch {
  try {
    return validateBatch(input);
  } catch (error) {
    if (error instanceof SignerError) throw error;
    throw invalid('batch could not be read');
  }
}

function validateBatch(input: unknown): ValidatedBatch {
  if (!isRecord(input)) throw invalid('batch must be an object');
  const id = requireNonEmptyString(requireBoundedString(input['id'], 'id', MAX_REQUEST_ID_LENGTH), 'id');
  const origin = validateOrigin(input['origin']);
  const receivedAt = input['receivedAt'];
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) {
    throw invalid('receivedAt must be a finite number');
  }
  const rawItems = input['items'];
  if (!Array.isArray(rawItems)) throw invalid('items must be an array');
  // O(1), before any item is read.
  if (rawItems.length === 0) throw invalid('items must hold at least one item');
  if (rawItems.length > MAX_BATCH_ITEMS) throw invalid(`items may hold at most ${MAX_BATCH_ITEMS} items`);

  const seen = new Set<string>();
  const items: ValidatedBatchItem[] = [];
  const wire: SignerBatchItem[] = [];
  let remaining = MAX_BATCH_BYTES;
  for (let index = 0; index < rawItems.length; index++) {
    const at = `items[${index}]`;
    const raw: unknown = rawItems[index];
    if (!isRecord(raw)) throw invalid(`${at} must be an object`);
    const itemId = requireNonEmptyString(requireBoundedString(raw['id'], `${at}.id`, MAX_REQUEST_ID_LENGTH), `${at}.id`);
    if (seen.has(itemId)) throw invalid(`${at}.id must be unique within the batch`);
    seen.add(itemId);
    const method = raw['method'];
    if (typeof method !== 'string' || !KEY_METHODS.has(method)) {
      throw invalid(`${at}.method must be one of ${[...KEY_METHODS].join(', ')}`);
    }
    const rawParams = raw['params'];
    if (!isRecord(rawParams)) throw invalid(`${at}.params must be an object`);
    let measured: MeasuredParams;
    try {
      measured = validateParams(method as SignerMethod, rawParams, remaining);
    } catch (error) {
      if (error instanceof SignerError) throw invalid(`${at}: ${error.message}`);
      throw error;
    }
    remaining -= measured.bytes;
    items.push({ id: itemId, params: measured.params });
    wire.push({ id: itemId, method: method as SignerMethod, params: wireParams(measured.params) });
  }
  const request: SignerBatchRequest = { id, origin, items: wire, receivedAt };
  return { request: deepFreeze(request), items: deepFreeze(items) };
}
