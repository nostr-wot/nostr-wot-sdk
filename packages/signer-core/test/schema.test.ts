/**
 * The boundary. Everything a transport hands the pipeline goes through `validateRequest`, and
 * nothing past it re-validates, so this is the one place a malformed request can be stopped.
 */
import { describe, test, expect } from 'vitest';
import {
  MAX_ORIGIN_DISPLAY_NAME_LENGTH,
  MAX_ORIGIN_ICON_LENGTH,
  MAX_ORIGIN_IDENTIFIER_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  validateRequest,
  SignerError,
  MAX_EVENT_TAGS,
  MAX_TAG_VALUES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  MAX_EVENT_BYTES,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
  validateBatchRequest,
  type SignerRequest,
  type SignerBatchRequest,
} from '../src/index.js';

const PUBKEY = 'ab'.repeat(32);

function base(method: SignerRequest['method'], params: Record<string, unknown>): SignerRequest {
  return {
    id: 'req_1',
    origin: { kind: 'web', identifier: 'example.com' },
    method,
    params,
    receivedAt: 1,
  };
}

const invalid = (input: unknown) => {
  expect(() => validateRequest(input)).toThrow(SignerError);
  try {
    validateRequest(input);
  } catch (error) {
    expect((error as SignerError).code).toBe('invalid_request');
    return (error as SignerError).message;
  }
  throw new Error('unreachable');
};

describe('the request envelope is bounded', () => {
  // The origin fields and the id are written verbatim into every persisted activity entry,
  // denied requests included, so an unbounded one is a storage-filling primitive for any
  // connected page. The limits bite before anything is copied.
  test.each([
    ['id', MAX_REQUEST_ID_LENGTH, (v: string) => ({ id: v })],
    ['origin.identifier', MAX_ORIGIN_IDENTIFIER_LENGTH, (v: string) => ({ origin: { kind: 'web', identifier: v } })],
    ['origin.displayName', MAX_ORIGIN_DISPLAY_NAME_LENGTH, (v: string) => ({ origin: { kind: 'web', identifier: 'example.com', displayName: v } })],
    ['origin.icon', MAX_ORIGIN_ICON_LENGTH, (v: string) => ({ origin: { kind: 'web', identifier: 'example.com', icon: v } })],
  ] as Array<[string, number, (v: string) => Record<string, unknown>]>)('%s is capped at its limit', (_field, limit, build) => {
    expect(limit).toBeGreaterThan(0);
    const at = { ...base('getPublicKey', {}), ...build('a'.repeat(limit)) };
    const over = { ...base('getPublicKey', {}), ...build('a'.repeat(limit + 1)) };
    expect(() => validateRequest(at)).not.toThrow();
    expect(invalid(over)).toMatch(/at most/i);
  });

  test('a multi-megabyte icon is refused quickly and the error names the limit, not the value', () => {
    const icon = 'x'.repeat(5 * 1024 * 1024);
    const started = performance.now();
    const message = invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier: 'example.com', icon } });
    expect(performance.now() - started).toBeLessThan(50);
    expect(message).not.toContain('xxxx');
  });
});

describe('the envelope', () => {
  test('accepts a well-formed request and copies it', () => {
    const input = base('getPublicKey', {});
    const { request } = validateRequest(input);
    expect(request).toEqual(input);
    expect(request).not.toBe(input);
    expect(request.origin).not.toBe(input.origin);
  });

  test('folds a web host to lowercase and strips a trailing dot', () => {
    const input = base('getPublicKey', {});
    input.origin = { kind: 'web', identifier: 'EXAMPLE.COM.' };
    expect(validateRequest(input).request.origin.identifier).toBe('example.com');
    input.origin = { kind: 'web', identifier: 'Sub.Example.com...' };
    expect(validateRequest(input).request.origin.identifier).toBe('sub.example.com');
  });

  test('accepts an exact http(s) origin, which is what a browser sends, as its own key', () => {
    for (const identifier of [
      'https://example.com',
      'http://example.com',
      'http://localhost:3000',
      'http://[::1]:8080',
      'https://example.com.',
      'https://sub.example.com:8443',
    ]) {
      const input = { ...base('getPublicKey', {}), origin: { kind: 'web' as const, identifier } };
      expect(validateRequest(input).request.origin.identifier).toBe(identifier);
    }
  });

  test('an http(s) origin is canonicalised: scheme and host lowercased, a default port dropped', () => {
    for (const [identifier, canonical] of [
      ['https://EXAMPLE.COM', 'https://example.com'],
      ['HTTPS://Example.com:443', 'https://example.com'],
      ['http://Example.com:80', 'http://example.com'],
      ['http://[0:0:0:0:0:0:0:1]:8080', 'http://[::1]:8080'],
      ['http://127.1', 'http://127.0.0.1'],
    ]) {
      const input = { ...base('getPublicKey', {}), origin: { kind: 'web' as const, identifier: identifier! } };
      expect(validateRequest(input).request.origin.identifier).toBe(canonical);
    }
  });

  test('a bare identifier has to be a hostname: lowercased, trailing dots off, an address written one way', () => {
    for (const [identifier, canonical] of [
      ['EXAMPLE.COM.', 'example.com'],
      ['127.1', '127.0.0.1'],
      ['0x7f.0.0.1', '127.0.0.1'],
      ['localhost', 'localhost'],
    ]) {
      const input = { ...base('getPublicKey', {}), origin: { kind: 'web' as const, identifier: identifier! } };
      expect(validateRequest(input).request.origin.identifier).toBe(canonical);
    }
    for (const identifier of ['example.com/', 'user@example.com', 'exa mple.com', 'example..com', 'ex\tample.com', '256.1.1.1']) {
      expect(invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier } })).toMatch(/origin|hostname/i);
    }
  });

  test('an opaque origin is refused: `null` is what a sandboxed iframe, a data: page and file:// report', () => {
    // Every such page reports the same `location.origin`, so a bucket keyed on it would be
    // shared by all of them and one remembered allow would cover every one. There is no
    // identity here to grant to, so there is no grant.
    for (const identifier of ['null', 'NULL', 'null.']) {
      expect(invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier } })).toMatch(/opaque|null/i);
    }
  });

  test('an http(s) URL that is not an origin, or carries credentials, is refused', () => {
    for (const identifier of [
      'https://example.com/',
      'https://example.com/path',
      'https://example.com?x',
      'https://user@example.com',
      'https://user:pw@example.com',
    ]) {
      expect(invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier } })).toMatch(/origin|hostname/i);
    }
  });

  test('refuses a colon in anything that is not an http(s) origin, so a transport namespace cannot be forged', () => {
    for (const identifier of [
      'nip55:com.evil.app',
      'nip46:' + PUBKEY,
      'example.com:443',
      'localhost:3000',
      '[::1]',
      'ftp://example.com',
      'file:///etc/passwd',
      'nostr:example.com',
    ]) {
      expect(invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier } })).toMatch(/origin|hostname/i);
    }
    expect(invalid({ ...base('getPublicKey', {}), origin: { kind: 'web', identifier: '...' } })).toMatch(/empty/i);
  });

  test('a request whose fields throw when read is an invalid request, not a raw error', () => {
    const booby = {
      ...base('getPublicKey', {}),
      get id(): string {
        throw new Error('caller-controlled text');
      },
    };
    expect(invalid(booby)).not.toMatch(/caller-controlled/);
    const trapped = new Proxy(base('getPublicKey', {}), {
      get() {
        throw new Error('trap');
      },
    });
    expect(invalid(trapped)).not.toMatch(/trap/);
  });

  test('a nip46 identifier is a lowercase hex pubkey', () => {
    const input = base('getPublicKey', {});
    input.origin = { kind: 'nip46', identifier: PUBKEY.toUpperCase() };
    expect(validateRequest(input).request.origin.identifier).toBe(PUBKEY);
    expect(invalid({ ...input, origin: { kind: 'nip46', identifier: 'npub1' + 'q'.repeat(58) } })).toMatch(/nip46/i);
  });

  test('leaves other identifiers as they are', () => {
    const input = base('getPublicKey', {});
    input.origin = { kind: 'nip55', identifier: 'com.Example.App' };
    expect(validateRequest(input).request.origin.identifier).toBe('com.Example.App');
  });

  test('keeps the optional origin fields', () => {
    const input = base('getPublicKey', {});
    input.origin = { kind: 'nip46', identifier: PUBKEY, displayName: 'Client', icon: 'https://x/i.png' };
    expect(validateRequest(input).request.origin).toEqual(input.origin);
  });

  test.each([
    ['null', null],
    ['a string', 'req'],
    ['a missing id', { ...base('getPublicKey', {}), id: undefined }],
    ['an empty id', { ...base('getPublicKey', {}), id: '' }],
    ['a numeric id', { ...base('getPublicKey', {}), id: 7 }],
    ['an unknown method', { ...base('getPublicKey', {}), method: 'getPrivateKey' }],
    ['a missing origin', { ...base('getPublicKey', {}), origin: undefined }],
    ['an unknown origin kind', { ...base('getPublicKey', {}), origin: { kind: 'tor', identifier: 'x' } }],
    ['an empty identifier', { ...base('getPublicKey', {}), origin: { kind: 'web', identifier: '' } }],
    ['a non-string displayName', { ...base('getPublicKey', {}), origin: { kind: 'web', identifier: 'x', displayName: 3 } }],
    ['a non-numeric receivedAt', { ...base('getPublicKey', {}), receivedAt: 'now' }],
    ['a NaN receivedAt', { ...base('getPublicKey', {}), receivedAt: Number.NaN }],
    ['non-object params', { ...base('getPublicKey', {}), params: 'x' }],
    ['array params', { ...base('getPublicKey', {}), params: [] }],
  ])('rejects %s', (_, input) => {
    invalid(input);
  });
});

describe('signEvent', () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    kind: 1,
    content: 'hello',
    tags: [['t', 'x']],
    ...overrides,
  });

  test('accepts a template and copies it deeply', () => {
    const input = base('signEvent', { event: event({ created_at: 5, pubkey: PUBKEY }) });
    const validated = validateRequest(input);
    expect(validated.params).toEqual({
      method: 'signEvent',
      event: { kind: 1, content: 'hello', tags: [['t', 'x']], created_at: 5, pubkey: PUBKEY },
    });
    const source = (input.params as { event: { tags: string[][] } }).event;
    source.tags[0]!.push('mutated');
    source.tags.push(['p', 'added']);
    expect(validated.params.method === 'signEvent' && validated.params.event.tags).toEqual([['t', 'x']]);
    expect((validated.request.params as { event: { tags: string[][] } }).event.tags).toEqual([['t', 'x']]);
  });

  test('drops fields that are not part of a template', () => {
    const input = base('signEvent', { event: event({ id: 'forged', sig: 'forged', extra: 1 }) });
    const { params, request } = validateRequest(input);
    expect(params.method === 'signEvent' && params.event).not.toHaveProperty('sig');
    expect(params.method === 'signEvent' && params.event).not.toHaveProperty('id');
    expect((request.params as { event: object }).event).not.toHaveProperty('extra');
  });

  test.each([
    ['no event', {}],
    ['a null event', { event: null }],
    ['a string kind', { event: event({ kind: '1' }) }],
    ['a negative kind', { event: event({ kind: -1 }) }],
    ['a fractional kind', { event: event({ kind: 1.5 }) }],
    ['a NaN kind', { event: event({ kind: Number.NaN }) }],
    ['a kind above 16 bits', { event: event({ kind: 70_000 }) }],
    ['a missing content', { event: { kind: 1, tags: [] } }],
    ['a numeric content', { event: event({ content: 1 }) }],
    ['a missing tags', { event: { kind: 1, content: '' } }],
    ['tags as an object', { event: event({ tags: {} }) }],
    ['a tag that is a string', { event: event({ tags: ['t'] }) }],
    ['a tag holding a number', { event: event({ tags: [['t', 1]] }) }],
    ['an empty tag', { event: event({ tags: [[]] }) }],
    ['a fractional created_at', { event: event({ created_at: 1.5 }) }],
    ['a negative created_at', { event: event({ created_at: -1 }) }],
    ['an uppercase author', { event: event({ pubkey: PUBKEY.toUpperCase() }) }],
    ['a short author', { event: event({ pubkey: PUBKEY.slice(2) }) }],
  ])('rejects %s', (_, params) => {
    invalid(base('signEvent', params));
  });

  test('bounds the tag count', () => {
    const tags = Array.from({ length: MAX_EVENT_TAGS }, () => ['t']);
    expect(() => validateRequest(base('signEvent', { event: event({ tags }) }))).not.toThrow();
    tags.push(['t']);
    expect(invalid(base('signEvent', { event: event({ tags }) }))).toMatch(/tags/i);
  });

  test('bounds the values in one tag', () => {
    const tag = Array.from({ length: MAX_TAG_VALUES }, () => 'v');
    expect(() => validateRequest(base('signEvent', { event: event({ tags: [tag] }) }))).not.toThrow();
    tag.push('v');
    expect(invalid(base('signEvent', { event: event({ tags: [tag] }) }))).toMatch(/tag/i);
  });

  test('bounds the whole event', () => {
    const content = 'x'.repeat(MAX_EVENT_BYTES);
    expect(invalid(base('signEvent', { event: event({ content }) }))).toMatch(/large/i);
  });

  test('rejects an oversized content before walking it', () => {
    const content = 'x'.repeat(200_000_000);
    const started = performance.now();
    expect(invalid(base('signEvent', { event: event({ content }) }))).toMatch(/large/i);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('rejects tags whose whole is oversized before copying or serialising them', () => {
    // Every part inside its own limit; the whole would be over a gigabyte. The arrays are
    // shared so building the input is cheap, and the validator has to stop at the first tag
    // that crosses the byte limit rather than materialise the lot.
    const tag = Array.from({ length: MAX_TAG_VALUES }, () => 'v'.repeat(110));
    const tags = Array.from({ length: MAX_EVENT_TAGS }, () => tag);
    const started = performance.now();
    let error: unknown;
    try {
      validateRequest(base('signEvent', { event: event({ tags }) }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SignerError);
    expect((error as SignerError).code).toBe('invalid_request');
    expect((error as SignerError).message).toMatch(/large/i);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('rejects a single oversized value in the last tag before copying or serialising it', () => {
    // No per-value length cap exists, so the accumulated per-value check is the only thing
    // between one huge value and the copy plus stringify. Isolated here: one tag, one value.
    const tags = [['x'.repeat(200_000_000)]];
    const started = performance.now();
    expect(invalid(base('signEvent', { event: event({ tags }) }))).toMatch(/large/i);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('rejects an oversized plaintext before measuring it', () => {
    const plaintext = 'x'.repeat(200_000_000);
    const started = performance.now();
    expect(invalid(base('nip44Encrypt', { pubkey: PUBKEY, plaintext }))).toMatch(/plaintext/i);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('measures the event in bytes, not characters', () => {
    // Four bytes per character: a quarter of the byte limit in characters is over it.
    const content = '\u{1F511}'.repeat(MAX_EVENT_BYTES / 4);
    expect(invalid(base('signEvent', { event: event({ content }) }))).toMatch(/large/i);
  });
});

describe('the crypto methods', () => {
  test('nip04Encrypt takes a pubkey and a plaintext', () => {
    const { params } = validateRequest(base('nip04Encrypt', { pubkey: PUBKEY, plaintext: 'hi', extra: 1 }));
    expect(params).toEqual({ method: 'nip04Encrypt', pubkey: PUBKEY, plaintext: 'hi' });
  });

  test('nip44Encrypt takes a pubkey and a plaintext, and without opts the scheme is classic', () => {
    const { params, request } = validateRequest(base('nip44Encrypt', { pubkey: PUBKEY, plaintext: 'hi', extra: 1 }));
    expect(params).toEqual({ method: 'nip44Encrypt', pubkey: PUBKEY, plaintext: 'hi', scheme: 'classic' });
    expect(request.params).toEqual({ pubkey: PUBKEY, plaintext: 'hi' });
  });

  test('nip04Decrypt takes a pubkey and a ciphertext', () => {
    const { params } = validateRequest(base('nip04Decrypt', { pubkey: PUBKEY, ciphertext: 'c2VjcmV0' }));
    expect(params).toEqual({ method: 'nip04Decrypt', pubkey: PUBKEY, ciphertext: 'c2VjcmV0' });
  });

  test('nip44Decrypt takes a pubkey and a ciphertext, and a payload that is not the envelope is classic', () => {
    const { params } = validateRequest(base('nip44Decrypt', { pubkey: PUBKEY, ciphertext: 'c2VjcmV0' }));
    expect(params).toEqual({ method: 'nip44Decrypt', pubkey: PUBKEY, ciphertext: 'c2VjcmV0', scheme: 'classic' });
  });

  test.each([
    ['an uppercase pubkey', { pubkey: PUBKEY.toUpperCase(), plaintext: 'x' }],
    ['a 63 character pubkey', { pubkey: PUBKEY.slice(1), plaintext: 'x' }],
    ['a 65 character pubkey', { pubkey: PUBKEY + 'a', plaintext: 'x' }],
    ['an npub', { pubkey: 'npub1' + 'q'.repeat(58), plaintext: 'x' }],
    ['a missing pubkey', { plaintext: 'x' }],
    ['a missing plaintext', { pubkey: PUBKEY }],
    ['a numeric plaintext', { pubkey: PUBKEY, plaintext: 1 }],
  ])('encrypt rejects %s', (_, params) => {
    invalid(base('nip44Encrypt', params));
  });

  test.each([
    ['a missing ciphertext', { pubkey: PUBKEY }],
    ['an empty ciphertext', { pubkey: PUBKEY, ciphertext: '' }],
    ['an object ciphertext', { pubkey: PUBKEY, ciphertext: {} }],
  ])('decrypt rejects %s', (_, params) => {
    invalid(base('nip44Decrypt', params));
  });

  test('bounds the plaintext in bytes', () => {
    const ok = 'x'.repeat(MAX_CRYPTO_PLAINTEXT_BYTES);
    expect(() => validateRequest(base('nip44Encrypt', { pubkey: PUBKEY, plaintext: ok }))).not.toThrow();
    expect(invalid(base('nip44Encrypt', { pubkey: PUBKEY, plaintext: ok + 'x' }))).toMatch(/plaintext/i);
    const multibyte = '\u{1F511}'.repeat(MAX_CRYPTO_PLAINTEXT_BYTES / 4 + 1);
    expect(invalid(base('nip44Encrypt', { pubkey: PUBKEY, plaintext: multibyte }))).toMatch(/plaintext/i);
  });

  test('bounds the ciphertext length', () => {
    const ok = 'x'.repeat(MAX_CRYPTO_CIPHERTEXT_LENGTH);
    expect(() => validateRequest(base('nip44Decrypt', { pubkey: PUBKEY, ciphertext: ok }))).not.toThrow();
    expect(invalid(base('nip44Decrypt', { pubkey: PUBKEY, ciphertext: ok + 'x' }))).toMatch(/ciphertext/i);
  });
});

describe('the parameterless methods', () => {
  test.each(['getPublicKey', 'getRelays'] as const)('%s ignores whatever params it is given', (method) => {
    const { params, request } = validateRequest(base(method, { anything: true }));
    expect(params).toEqual({ method });
    expect(request.params).toEqual({});
  });
});

// ── Batches ──

/** A template with content and one tag, so `event({ kind: 7 })` is complete. */
const event = (overrides: Record<string, unknown> = {}) => ({ kind: 1, content: 'hello', tags: [['t', 'x']], ...overrides });

/** A batch from `example.com`, with item ids defaulted to their index. */
function batch(items: Array<{ id?: string; method: SignerRequest['method']; params: Record<string, unknown> }>): SignerBatchRequest {
  return {
    id: 'batch_1',
    origin: { kind: 'web', identifier: 'example.com' },
    items: items.map((item, index) => ({ id: item.id ?? `item_${index}`, method: item.method, params: item.params })),
    receivedAt: 1,
  };
}

const invalidBatch = (input: unknown) => {
  expect(() => validateBatchRequest(input)).toThrow(SignerError);
  try {
    validateBatchRequest(input);
  } catch (error) {
    expect((error as SignerError).code).toBe('invalid_request');
    return (error as SignerError).message;
  }
  throw new Error('unreachable');
};

describe('a batch at the boundary', () => {
  test('accepts a batch of key methods, typed per item, copied and frozen', () => {
    const input = batch([
      { method: 'signEvent', params: { event: event({ kind: 7, content: '+', tags: [['e', 'a'.repeat(64)]] }) } },
      { method: 'nip44Encrypt', params: { pubkey: PUBKEY, plaintext: 'hi', extra: 1 } },
      { method: 'nip04Decrypt', params: { pubkey: PUBKEY, ciphertext: 'c2VjcmV0' } },
    ]);
    const { request, items } = validateBatchRequest(input);
    expect(request).not.toBe(input);
    expect(request.id).toBe('batch_1');
    expect(request.items.map((item) => item.id)).toEqual(['item_0', 'item_1', 'item_2']);
    expect(items.map((item) => item.params)).toEqual([
      { method: 'signEvent', event: { kind: 7, content: '+', tags: [['e', 'a'.repeat(64)]] } },
      { method: 'nip44Encrypt', pubkey: PUBKEY, plaintext: 'hi', scheme: 'classic' },
      { method: 'nip04Decrypt', pubkey: PUBKEY, ciphertext: 'c2VjcmV0' },
    ]);
    // The wire copy carries only what was validated, and none of it is the caller's object.
    expect(request.items[1]!.params).toEqual({ pubkey: PUBKEY, plaintext: 'hi' });
    expect(request.items[0]!.params['event']).not.toBe(input.items[0]!.params['event']);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.items)).toBe(true);
    expect(Object.isFrozen((request.items[0]!.params['event'] as { tags: string[][] }).tags[0])).toBe(true);
    expect(Object.isFrozen(items[0]!.params)).toBe(true);
  });

  test('an empty batch is refused: there is nothing to approve', () => {
    expect(invalidBatch(batch([]))).toMatch(/at least one/i);
  });

  test('more items than the cap are refused before a single item is read', () => {
    const template = { method: 'signEvent', params: { event: event({}) } };
    const items: unknown[] = new Array(MAX_BATCH_ITEMS + 1).fill(template);
    let reads = 0;
    Object.defineProperty(items, 0, {
      get() {
        reads += 1;
        return template;
      },
    });
    expect(invalidBatch({ ...batch([]), items })).toMatch(new RegExp(`at most ${MAX_BATCH_ITEMS} items`));
    expect(reads).toBe(0);
    // And exactly the cap is fine.
    const exact = Array.from({ length: MAX_BATCH_ITEMS }, (_, i) => ({ id: `i${i}`, ...template }));
    expect(validateBatchRequest({ ...batch([]), items: exact }).items).toHaveLength(MAX_BATCH_ITEMS);
  });

  test('a duplicate item id is refused, so every outcome can be matched to its item', () => {
    const input = batch([
      { id: 'same', method: 'signEvent', params: { event: event({}) } },
      { id: 'same', method: 'signEvent', params: { event: event({}) } },
    ]);
    expect(invalidBatch(input)).toMatch(/items\[1\].*id.*unique|duplicate/i);
  });

  test.each(['getPublicKey', 'getRelays'] as const)('%s is not a batch item: it does not use the key', (method) => {
    expect(invalidBatch(batch([{ method, params: {} }]))).toMatch(/items\[0\].*method/i);
  });

  test('an item id is bounded like a request id, and must not be empty', () => {
    const okId = 'a'.repeat(MAX_REQUEST_ID_LENGTH);
    expect(() => validateBatchRequest(batch([{ id: okId, method: 'signEvent', params: { event: event({}) } }]))).not.toThrow();
    expect(invalidBatch(batch([{ id: okId + 'a', method: 'signEvent', params: { event: event({}) } }]))).toMatch(/at most/i);
    expect(invalidBatch(batch([{ id: '', method: 'signEvent', params: { event: event({}) } }]))).toMatch(/empty/i);
  });

  test('a malformed item names its index', () => {
    const input = batch([
      { method: 'signEvent', params: { event: event({}) } },
      { method: 'signEvent', params: { event: event({ kind: '1' as unknown as number }) } },
    ]);
    expect(invalidBatch(input)).toMatch(/items\[1\]/);
    expect(invalidBatch({ ...batch([]), items: [null] })).toMatch(/items\[0\]/);
  });

  test('each item is still bounded on its own', () => {
    const content = 'x'.repeat(MAX_EVENT_BYTES);
    expect(invalidBatch(batch([{ method: 'signEvent', params: { event: event({ content }) } }]))).toMatch(/event is too large/i);
  });

  test('a batch can hold no more than one request can: the aggregate cap is the per-event cap', () => {
    // A batch is one queued request and is bounded like one. Whatever the pipeline may hold
    // in flight for N single requests, N batches hold no more; batching is not the way
    // around the per-event limit, and this is the line that makes that so.
    expect(MAX_BATCH_BYTES).toBe(MAX_EVENT_BYTES);
  });

  test('every item legal on its own, the whole over the cap: refused before the crossing item is walked', () => {
    // Three events of 400 KiB each. Each is well under MAX_EVENT_BYTES; together they are
    // over MAX_BATCH_BYTES. The third item's content is over the remaining budget, so its
    // tags must never be read, let alone copied: the cap has to bite on the O(1) length
    // check, before the walk.
    const content = 'x'.repeat(400 * 1024);
    let tagsRead = 0;
    const third = {
      kind: 1,
      content,
      get tags() {
        tagsRead += 1;
        return [] as string[][];
      },
    };
    const input = batch([
      { method: 'signEvent', params: { event: event({ content }) } },
      { method: 'signEvent', params: { event: event({ content }) } },
      { method: 'signEvent', params: { event: third } },
    ]);
    const started = performance.now();
    expect(invalidBatch(input)).toMatch(/batch is too large/i);
    expect(performance.now() - started).toBeLessThan(200);
    expect(tagsRead).toBe(0);
    // Two of them fit.
    expect(() => validateBatchRequest(batch(input.items.slice(0, 2).map((item) => ({ method: item.method, params: item.params }))))).not.toThrow();
  });

  test('the aggregate is measured over the tags too, and stops at the tag that crosses', () => {
    const tag = ['t', 'v'.repeat(1000)];
    const tags = Array.from({ length: 500 }, () => tag); // ~500 KiB per event
    const one = { method: 'signEvent' as const, params: { event: event({ tags }) } };
    expect(() => validateBatchRequest(batch([one]))).not.toThrow();
    expect(() => validateBatchRequest(batch([one, one]))).not.toThrow();
    const started = performance.now();
    expect(invalidBatch(batch([one, one, one]))).toMatch(/batch is too large/i);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('crypto items count toward the aggregate as well', () => {
    const plaintext = 'x'.repeat(MAX_CRYPTO_PLAINTEXT_BYTES);
    const count = Math.ceil(MAX_BATCH_BYTES / MAX_CRYPTO_PLAINTEXT_BYTES) + 1;
    expect(count).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
    const items = Array.from({ length: count }, () => ({ method: 'nip44Encrypt' as const, params: { pubkey: PUBKEY, plaintext } }));
    expect(invalidBatch(batch(items))).toMatch(/batch is too large/i);
    const ciphertext = 'x'.repeat(MAX_CRYPTO_CIPHERTEXT_LENGTH);
    const decrypts = Array.from({ length: Math.ceil(MAX_BATCH_BYTES / MAX_CRYPTO_CIPHERTEXT_LENGTH) + 1 }, () => ({
      method: 'nip04Decrypt' as const,
      params: { pubkey: PUBKEY, ciphertext },
    }));
    expect(invalidBatch(batch(decrypts))).toMatch(/batch is too large/i);
  });

  test('the batch envelope is validated like a request envelope', () => {
    const one = { method: 'signEvent' as const, params: { event: event({}) } };
    expect(invalidBatch({ ...batch([one]), id: '' })).toMatch(/id/);
    expect(invalidBatch({ ...batch([one]), origin: { kind: 'web', identifier: 'null' } })).toMatch(/opaque/i);
    expect(invalidBatch({ ...batch([one]), receivedAt: 'now' })).toMatch(/receivedAt/);
    expect(invalidBatch({ ...batch([one]), items: 'nope' })).toMatch(/items must be an array/i);
    expect(invalidBatch(null)).toMatch(/object/i);
    expect(validateBatchRequest({ ...batch([one]), origin: { kind: 'web', identifier: 'EXAMPLE.COM.' } }).request.origin.identifier).toBe('example.com');
  });

  test('a batch whose item throws when read is a SignerError, never a raw error', () => {
    const trapped = new Proxy(batch([{ method: 'signEvent', params: { event: event({}) } }]), {
      get(target, property) {
        if (property === 'items') throw new Error('EACCES /Users/leon/secret');
        return Reflect.get(target, property);
      },
    });
    expect(invalidBatch(trapped)).not.toMatch(/leon/);
  });
});
