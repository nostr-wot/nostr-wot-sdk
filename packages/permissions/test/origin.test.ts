/**
 * Origin canonicalisation, done here rather than delegated to the host's `URL`.
 *
 * The property: one spelling per caller, so a rule stored for `https://example.com` cannot
 * be dodged by `https://EXAMPLE.COM`, `https://example.com:443`, `https://user@example.com`
 * or an IPv6 / IPv4 address written differently. `new URL(x).origin === x` proves that only
 * under a WHATWG parser. React Native's `URL` (0.86, `Libraries/Blob/URL.js`) implements
 * `origin`, `protocol` and `hostname` as regex slices with no lowercasing and no default-port
 * folding, so on the phone that check passes every one of those spellings as its own key.
 * The last block here runs the same assertions under a fake shaped like React Native's, and
 * checks that the implementation never consulted `URL` at all.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { canonicalHostname, canonicalHttpOrigin, siteScopes } from '../src/index.js';

const CANONICAL: Array<[string, string]> = [
  ['https://example.com', 'https://example.com'],
  ['https://EXAMPLE.COM', 'https://example.com'],
  ['HTTPS://Example.Com', 'https://example.com'],
  ['https://example.com:443', 'https://example.com'],
  ['http://example.com:80', 'http://example.com'],
  ['https://example.com:0443', 'https://example.com'],
  ['https://example.com:8443', 'https://example.com:8443'],
  ['http://example.com:443', 'http://example.com:443'],
  ['http://localhost:3000', 'http://localhost:3000'],
  ['http://LocalHost:03000', 'http://localhost:3000'],
  ['https://sub.example.com.', 'https://sub.example.com.'],
  ['http://[::1]:8080', 'http://[::1]:8080'],
  ['http://[0:0:0:0:0:0:0:1]:8080', 'http://[::1]:8080'],
  ['http://[FE80::1]', 'http://[fe80::1]'],
  ['http://[2001:db8:0:0:1:0:0:1]', 'http://[2001:db8::1:0:0:1]'],
  ['http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]'],
  ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ['http://127.1', 'http://127.0.0.1'],
  ['http://0x7f.0.0.1', 'http://127.0.0.1'],
  ['http://2130706433', 'http://127.0.0.1'],
  ['http://0177.0.0.1', 'http://127.0.0.1'],
  ['http://127.0.0.1.', 'http://127.0.0.1'],
  ['http://0x.1', 'http://0.0.0.1'],
];

const REFUSED = [
  'example.com',
  'https://example.com/',
  'https://example.com/path',
  'https://example.com?q',
  'https://example.com#f',
  'https://user@example.com',
  'https://user:pw@example.com',
  'https://',
  'https://:443',
  'https://example.com:',
  'https://example.com:99999',
  'https://example.com:4x3',
  'https://exa mple.com',
  'https://example.com\\evil',
  'https://ex\tample.com',
  'https://[::1',
  'https://[::1]x',
  'https://[zz::1]',
  'https://[1:2:3:4:5:6:7:8:9]',
  'http://256.0.0.1',
  'http://1.2.3.4.5',
  'ftp://example.com',
  'file:///etc/passwd',
  'nip55:com.evil.app',
  'nostr:example.com',
  'https:/example.com',
  'https//example.com',
  '',
];

describe('canonicalHttpOrigin', () => {
  test.each(CANONICAL)('%s -> %s', (input, expected) => {
    expect(canonicalHttpOrigin(input)).toBe(expected);
  });

  test.each(REFUSED)('%j is not an http(s) origin', (input) => {
    expect(canonicalHttpOrigin(input)).toBeNull();
  });

  test('under Node, every canonical form is what the WHATWG parser produces', () => {
    // The parser here is hand written so it does not depend on the host's; this pins it to
    // the standard where a standard parser is available, so it cannot drift on its own.
    for (const [input, expected] of CANONICAL) expect(new URL(input).origin, input).toBe(expected);
  });

  test('canonical output is a fixed point', () => {
    for (const [, canonical] of CANONICAL) expect(canonicalHttpOrigin(canonical)).toBe(canonical);
  });
});

describe('canonicalHostname', () => {
  test.each([
    ['example.com', 'example.com'],
    ['EXAMPLE.COM.', 'example.com'],
    ['sub.example.com...', 'sub.example.com'],
    ['127.1', '127.0.0.1'],
    ['0x7f.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ] as Array<[string, string]>)('%s -> %s', (input, expected) => {
    expect(canonicalHostname(input)).toBe(expected);
  });

  test.each(['', '...', 'example.com/', 'user@example.com', 'exa mple.com', 'example..com', 'https://example.com', '[::1]', 'localhost:3000', '256.1.1.1', 'ex\tample.com'])(
    '%j is not a hostname',
    (input) => {
      expect(canonicalHostname(input)).toBeNull();
    },
  );
});

describe('siteScopes reads the canonical origin, then the legacy hostname', () => {
  test('every spelling of one origin reads the same two labels', () => {
    for (const spelling of ['https://example.com', 'https://EXAMPLE.COM', 'https://example.com:443']) {
      expect(siteScopes(spelling)).toEqual(['https://example.com', 'example.com']);
    }
    expect(siteScopes('http://[0:0:0:0:0:0:0:1]:8080')).toEqual(['http://[::1]:8080', '[::1]']);
    expect(siteScopes('http://127.1')).toEqual(['http://127.0.0.1', '127.0.0.1']);
  });

  test('anything that is not an http(s) origin is only ever itself', () => {
    expect(siteScopes('example.com')).toEqual(['example.com']);
    expect(siteScopes('com.example.android')).toEqual(['com.example.android']);
    expect(siteScopes('nip46:' + 'ab'.repeat(32))).toEqual(['nip46:' + 'ab'.repeat(32)]);
    expect(siteScopes('https://example.com/path')).toEqual(['https://example.com/path']);
  });
});

/**
 * Shaped like React Native 0.86's `URL`: `href` is what was given, and `protocol`, `hostname`,
 * `port` and `origin` are regex slices of it. Nothing is lowercased and no port is folded.
 */
class ReactNativeLikeURL {
  static calls = 0;
  readonly href: string;
  constructor(url: string) {
    ReactNativeLikeURL.calls += 1;
    this.href = url;
  }
  get protocol(): string {
    return this.href.slice(0, this.href.indexOf(':') + 1);
  }
  get hostname(): string {
    const m = /^[^:]+:\/\/([^/:?#]*)/.exec(this.href);
    return m ? m[1]! : '';
  }
  get port(): string {
    const m = /^[^:]+:\/\/[^/:?#]*:(\d+)/.exec(this.href);
    return m ? m[1]! : '';
  }
  get origin(): string {
    const m = /^([^:]+:\/\/[^/?#]*)/.exec(this.href);
    return m ? m[1]! : '';
  }
  toString(): string {
    return this.href;
  }
}

describe('under a URL shaped like React Native\'s', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    ReactNativeLikeURL.calls = 0;
  });

  test('the fake really does pass the spellings a WHATWG parser would fold', () => {
    // Otherwise this block proves nothing: a fake that folds is Node's URL again.
    const upper = new ReactNativeLikeURL('https://EXAMPLE.COM');
    expect(upper.origin).toBe('https://EXAMPLE.COM');
    const port = new ReactNativeLikeURL('https://example.com:443');
    expect(port.origin).toBe('https://example.com:443');
    const user = new ReactNativeLikeURL('https://user:pw@example.com');
    expect(user.origin).toBe('https://user:pw@example.com');
  });

  test('canonicalisation and refusal are the same as under Node, and URL is never consulted', () => {
    vi.stubGlobal('URL', ReactNativeLikeURL);
    for (const [input, expected] of CANONICAL) expect(canonicalHttpOrigin(input), input).toBe(expected);
    for (const input of REFUSED) expect(canonicalHttpOrigin(input), input).toBeNull();
    expect(siteScopes('https://EXAMPLE.COM:443')).toEqual(['https://example.com', 'example.com']);
    expect(ReactNativeLikeURL.calls).toBe(0);
  });
});
