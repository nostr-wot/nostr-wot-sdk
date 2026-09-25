/**
 * The boundary. Everything a transport hands the pipeline goes through `validateRequest`, and
 * nothing past it re-validates, so this is the one place a malformed request can be stopped.
 */
import { describe, test, expect } from 'vitest';
import {
  validateRequest,
  SignerError,
  MAX_EVENT_TAGS,
  MAX_TAG_VALUES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  MAX_EVENT_BYTES,
  type SignerRequest,
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
  test.each(['nip04Encrypt', 'nip44Encrypt'] as const)('%s takes a pubkey and a plaintext', (method) => {
    const { params } = validateRequest(base(method, { pubkey: PUBKEY, plaintext: 'hi', extra: 1 }));
    expect(params).toEqual({ method, pubkey: PUBKEY, plaintext: 'hi' });
  });

  test.each(['nip04Decrypt', 'nip44Decrypt'] as const)('%s takes a pubkey and a ciphertext', (method) => {
    const { params } = validateRequest(base(method, { pubkey: PUBKEY, ciphertext: 'c2VjcmV0' }));
    expect(params).toEqual({ method, pubkey: PUBKEY, ciphertext: 'c2VjcmV0' });
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
