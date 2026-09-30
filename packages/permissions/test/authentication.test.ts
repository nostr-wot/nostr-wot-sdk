/**
 * The pure half of the destination model: what an authentication event is addressed to, and
 * every reason one is refused.
 *
 * Each rejection below is its own test on purpose. The extension's suite loops a list of
 * malformed events through one `assert.rejects`, which passes as long as SOMETHING throws —
 * and a validation function that threw for the wrong reason, or that had lost one of its
 * checks while another still fired, would pass it. These are credentials; the checks are the
 * product. So each one names the input it refuses and the property that refuses it.
 *
 * The last block runs the same assertions with `URL` replaced by a fake shaped like React
 * Native's, which is the whole reason this module does not use one.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  NIP42_KIND,
  NIP98_KIND,
  authenticationKey,
  parseAuthentication,
  validAuthenticationScope,
  type AuthenticationEventInput,
  type AuthenticationRequest,
} from '../src/index.js';

const SITE = 'https://client.test';
const NOW = 1_700_000_000;

/** A well-formed NIP-98 event. Every test that refuses one changes exactly one thing here. */
function http(url = 'https://api.test/login', extra: Partial<AuthenticationEventInput> = {}): AuthenticationEventInput {
  return {
    kind: NIP98_KIND,
    content: '',
    created_at: NOW,
    tags: [
      ['u', url],
      ['method', 'POST'],
    ],
    ...extra,
  };
}

/** A well-formed NIP-42 event. */
function relay(url = 'wss://relay.test/', extra: Partial<AuthenticationEventInput> = {}): AuthenticationEventInput {
  return {
    kind: NIP42_KIND,
    content: '',
    created_at: NOW,
    tags: [
      ['relay', url],
      ['challenge', 'random-connection-challenge'],
    ],
    ...extra,
  };
}

function parse(event: AuthenticationEventInput, origin = SITE): AuthenticationRequest | undefined {
  return parseAuthentication(event, origin, NOW);
}

describe('what is and is not an authentication event', () => {
  test('an ordinary kind is not one, and is not an error either', () => {
    // undefined and a throw mean different things: this is "decide it the ordinary way".
    expect(parse({ ...http(), kind: 1 })).toBeUndefined();
    expect(parse({ ...http(), kind: 0 })).toBeUndefined();
    expect(parse({ ...relay(), kind: 24242 })).toBeUndefined();
  });

  test('NIP-98 reports its destination origin, its method and that it is cross-origin', () => {
    expect(parse(http())).toEqual({
      protocol: 'nip98',
      url: 'https://api.test/login',
      destination: 'https://api.test',
      method: 'POST',
      crossOrigin: true,
    });
  });

  test('a same-origin NIP-98 request says so', () => {
    const auth = parse(http(`${SITE}/login`))!;
    expect(auth.crossOrigin).toBe(false);
    expect(auth.destination).toBe(SITE);
  });

  test('NIP-42 is always cross-origin, because a relay is never the page', () => {
    expect(parse(relay())).toEqual({
      protocol: 'nip42',
      url: 'wss://relay.test/',
      destination: 'wss://relay.test/',
      crossOrigin: true,
    });
  });
});

describe('the destination is canonical for lookup and verbatim for display', () => {
  test('the signed URL is preserved exactly while the destination folds case and default port', () => {
    const auth = parse(http('https://API.TEST:443/login?x=%2F'))!;
    expect(auth.url).toBe('https://API.TEST:443/login?x=%2F');
    expect(auth.destination).toBe('https://api.test');
  });

  test('a relay destination keeps path and query but folds case, default port and an absent path', () => {
    expect(parse(relay('wss://RELAY.TEST:443'))!.destination).toBe('wss://relay.test/');
    expect(parse(relay('wss://relay.test'))!.destination).toBe('wss://relay.test/');
    expect(parse(relay('wss://relay.test/team-a?tenant=b'))!.destination).toBe('wss://relay.test/team-a?tenant=b');
    expect(parse(relay('wss://relay.test?tenant=b'))!.destination).toBe('wss://relay.test/?tenant=b');
  });

  test('a relay path, port and query each make a different destination', () => {
    const destinations = [
      'wss://relay.test/team-a',
      'wss://relay.test/team-b',
      'wss://relay.test:8443/team-a',
      'wss://relay.test/team-a?tenant=b',
    ].map((url) => parse(relay(url))!.destination);
    expect(new Set(destinations).size).toBe(4);
  });

  test('a dot segment is kept verbatim, which splits a grant rather than merging two', () => {
    // `URL.href` would resolve this to `wss://relay.test/b`. Splitting costs an extra prompt;
    // merging would hand a consent for one resource to another, so verbatim is the safe side.
    expect(parse(relay('wss://relay.test/a/../b'))!.destination).toBe('wss://relay.test/a/../b');
    expect(parse(relay('wss://relay.test/a/../b'))!.destination).not.toBe(
      parse(relay('wss://relay.test/b'))!.destination,
    );
  });

  test('an IP address destination is canonical, so one relay is not two grant keys', () => {
    expect(parse(relay('ws://127.1/'))!.destination).toBe('ws://127.0.0.1/');
    expect(parse(relay('ws://[0:0:0:0:0:0:0:1]/'))!.destination).toBe('ws://[::1]/');
  });
});

describe('the requesting origin', () => {
  test('is refused unless the host handed us its canonical spelling', () => {
    // A host that passes a page's URL through rather than resolving an origin would otherwise
    // key every grant under a second spelling of the same site.
    for (const origin of ['https://CLIENT.TEST', 'https://client.test:443', 'https://client.test/', '']) {
      expect(() => parse(http(), origin)).toThrow(/Invalid authentication destination/);
    }
  });

  test('may be plain http only on loopback', () => {
    expect(() => parse(http('http://localhost:3000/login'), 'http://client.test')).toThrow(
      /Invalid authentication destination/,
    );
    expect(parse(http('http://localhost:3000/login'), 'http://localhost:3000')!.crossOrigin).toBe(false);
    expect(parse(http('http://localhost:3000/login'), 'http://127.0.0.1:5173')!.crossOrigin).toBe(true);
  });

  test('may not be a non-web scheme', () => {
    for (const origin of ['file://', 'chrome-extension://abcdef', 'null']) {
      expect(() => parse(http(), origin)).toThrow(/Invalid authentication destination/);
    }
  });
});

describe('the destination URL, rejection by rejection', () => {
  test('plain http is refused for NIP-98 unless the destination is loopback', () => {
    expect(() => parse(http('http://api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(parse(http('http://127.0.0.1:8080/login'))!.destination).toBe('http://127.0.0.1:8080');
  });

  test('plain ws is refused for NIP-42 unless the relay is loopback', () => {
    expect(() => parse(relay('ws://relay.test/'))).toThrow(/Invalid authentication destination/);
    expect(parse(relay('ws://localhost:7777/'))!.destination).toBe('ws://localhost:7777/');
  });

  test('the protocols do not borrow each other\'s schemes', () => {
    expect(() => parse(http('wss://relay.test/'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(relay('https://api.test/login'))).toThrow(/Invalid authentication destination/);
  });

  test('credentials in the URL are refused', () => {
    // The user reads a hostname off the prompt; the request authenticates as someone else.
    expect(() => parse(http('https://user:password@api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http('https://user@api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(relay('wss://user:pw@relay.test/'))).toThrow(/Invalid authentication destination/);
  });

  test('a fragment is refused', () => {
    // Never sent to the server, so the string shown is not the string that arrives.
    expect(() => parse(http('https://api.test/#fragment'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http('https://api.test/login#'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(relay('wss://relay.test/#x'))).toThrow(/Invalid authentication destination/);
  });

  test('control characters are refused', () => {
    for (const url of [
      'https://api.test/\nlogin',
      'https://api.test/\rlogin',
      'https://api.test/log in',
      'https://api.test/login\t',
      'https://api.test/log in',
      'https://api.test/login',
    ]) {
      expect(() => parse(http(url))).toThrow(/Invalid authentication destination/);
    }
  });

  test('a backslash is refused', () => {
    // A path separator to some servers and a literal to others, so the resource is ambiguous.
    expect(() => parse(http('https://api.test/\\login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(relay('wss://relay.test/\\team'))).toThrow(/Invalid authentication destination/);
  });

  test('surrounding whitespace is refused, including the kind a control-character scan misses', () => {
    expect(() => parse(http(' https://api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http('https://api.test/login '))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http(' https://api.test/login'))).toThrow(/Invalid authentication destination/);
    // A TRAILING non-breaking space is the case the trim check exists for, and the only one:
    // its code point is 160, so the control-character scan passes it, and it is not at the
    // front where the scheme anchor would reject it. Without the trim check this is accepted.
    expect(() => parse(http('https://api.test/login '))).toThrow(/Invalid authentication destination/);
    expect(() => parse(relay('wss://relay.test/team '))).toThrow(/Invalid authentication destination/);
  });

  test('a non-URL is refused rather than parsed into something', () => {
    for (const url of ['javascript:alert(1)', 'api.test/login', 'https:/api.test', 'https://', 'https://:8443/x']) {
      expect(() => parse(http(url))).toThrow(/Invalid authentication destination/);
    }
  });
});

describe('the single-tag rule', () => {
  test('two destination tags throw rather than one of them being chosen', () => {
    // The point of refusing: a user shown one destination while the signer reads another.
    expect(() =>
      parse(http(undefined, { tags: [['u', 'https://api.test'], ['u', 'https://evil.test'], ['method', 'GET']] })),
    ).toThrow(/Invalid authentication u tag/);
    expect(() =>
      parse(relay(undefined, {
        tags: [['relay', 'wss://a.test/'], ['relay', 'wss://b.test/'], ['challenge', 'x']],
      })),
    ).toThrow(/Invalid authentication relay tag/);
  });

  test('a missing, empty or overlong destination tag throws', () => {
    expect(() => parse(http(undefined, { tags: [['method', 'GET']] }))).toThrow(/Invalid authentication u tag/);
    expect(() => parse(http(undefined, { tags: [['u', ''], ['method', 'GET']] }))).toThrow(
      /Invalid authentication u tag/,
    );
    expect(() =>
      parse(http(undefined, { tags: [['u', 'https://api.test', 'extra'], ['method', 'GET']] })),
    ).toThrow(/Invalid authentication u tag/);
  });

  test('a NIP-42 event needs exactly one challenge', () => {
    expect(() => parse(relay(undefined, { tags: [['relay', 'wss://relay.test/']] }))).toThrow(
      /Invalid authentication challenge tag/,
    );
    expect(() =>
      parse(relay(undefined, {
        tags: [['relay', 'wss://relay.test/'], ['challenge', 'a'], ['challenge', 'b']],
      })),
    ).toThrow(/Invalid authentication challenge tag/);
  });

  test('a NIP-98 event needs exactly one method', () => {
    expect(() => parse(http(undefined, { tags: [['u', 'https://api.test/login']] }))).toThrow(
      /Invalid authentication method tag/,
    );
    expect(() =>
      parse(http(undefined, {
        tags: [['u', 'https://api.test/login'], ['method', 'GET'], ['method', 'DELETE']],
      })),
    ).toThrow(/Invalid authentication method tag/);
  });
});

describe('an origin the caller states about itself', () => {
  /** A NIP-98 event carrying a self-declared origin tag. */
  function tagged(name: string, value: string): AuthenticationEventInput {
    return http(undefined, {
      tags: [['u', 'https://api.test/login'], ['method', 'POST'], [name, value]],
    });
  }

  test('an agreeing tag is accepted and grants nothing extra', () => {
    // Accepted, not trusted: the request is exactly as cross-origin as it was without the tag.
    for (const name of ['origin', 'client-origin']) {
      expect(parse(tagged(name, SITE))!.crossOrigin).toBe(true);
    }
  });

  test('a contradicting tag is refused', () => {
    // Otherwise one string is shown to a user or sent to a server while the other is authorised,
    // and the event goes out with both in it.
    for (const name of ['origin', 'client-origin']) {
      for (const claimed of ['https://evil.test', 'https://CLIENT.TEST', 'client.test', '']) {
        expect(() => parse(tagged(name, claimed))).toThrow(new RegExp(`Invalid authentication ${name} tag`));
      }
    }
  });

  test('two of them are refused even when one agrees', () => {
    expect(() =>
      parse(http(undefined, {
        tags: [['u', 'https://api.test/login'], ['method', 'POST'], ['origin', SITE], ['origin', 'https://evil.test']],
      })),
    ).toThrow(/Invalid authentication origin tag/);
  });

  test('the check applies to a relay event too', () => {
    expect(() =>
      parse(relay(undefined, {
        tags: [['relay', 'wss://relay.test/'], ['challenge', 'c'], ['client-origin', 'https://evil.test']],
      })),
    ).toThrow(/Invalid authentication client-origin tag/);
  });
});

describe('the rest of the event', () => {
  test('the age window is 600 seconds for a relay and 60 for HTTP', () => {
    expect(parse({ ...relay(), created_at: NOW - 600 })).toBeDefined();
    expect(() => parse({ ...relay(), created_at: NOW - 601 })).toThrow(/Invalid authentication timestamp/);
    expect(parse({ ...http(), created_at: NOW - 60 })).toBeDefined();
    expect(() => parse({ ...http(), created_at: NOW - 61 })).toThrow(/Invalid authentication timestamp/);
  });

  test('the window is symmetric, so a future-dated token is refused too', () => {
    expect(parse({ ...http(), created_at: NOW + 60 })).toBeDefined();
    expect(() => parse({ ...http(), created_at: NOW + 61 })).toThrow(/Invalid authentication timestamp/);
    expect(() => parse({ ...relay(), created_at: NOW + 601 })).toThrow(/Invalid authentication timestamp/);
  });

  test('a non-integer timestamp is refused rather than coerced', () => {
    for (const created_at of [NaN, 1.5, Infinity, 0 / 0]) {
      expect(() => parse({ ...http(), created_at })).toThrow(/Invalid authentication timestamp/);
    }
    expect(() => parse({ ...http(), created_at: '1700000000' as unknown as number })).toThrow(
      /Invalid authentication timestamp/,
    );
  });

  test('content must be empty, so nothing rides inside the credential', () => {
    expect(() => parse({ ...http(), content: 'x' })).toThrow(/Invalid authentication content/);
    expect(() => parse({ ...http(), content: ' ' })).toThrow(/Invalid authentication content/);
    expect(() => parse({ ...relay(), content: '{}' })).toThrow(/Invalid authentication content/);
    expect(() => parse({ ...http(), content: undefined as unknown as string })).toThrow(
      /Invalid authentication content/,
    );
  });

  test('the HTTP method must be an uppercase token', () => {
    expect(parse(http(undefined, { tags: [['u', 'https://api.test/x'], ['method', 'DELETE']] }))!.method).toBe(
      'DELETE',
    );
    for (const method of ['get', 'GET POST', 'GET/POST', 'GET\n', '"GET"']) {
      expect(() =>
        parse(http(undefined, { tags: [['u', 'https://api.test/x'], ['method', method]] })),
      ).toThrow(/Invalid authentication (HTTP method|method tag)/);
    }
  });

  test('a payload tag, when present, must be exactly one SHA-256 hex digest', () => {
    const hex = 'a'.repeat(64);
    const tags = (...payload: string[][]) => [['u', 'https://api.test/x'], ['method', 'POST'], ...payload];
    expect(parse(http(undefined, { tags: tags(['payload', hex]) }))!.method).toBe('POST');
    for (const bad of [
      [['payload', hex], ['payload', hex]],
      [['payload', 'A'.repeat(64)]],
      [['payload', 'a'.repeat(63)]],
      [['payload', '']],
      [['payload', hex, 'extra']],
    ]) {
      expect(() => parse(http(undefined, { tags: tags(...bad) }))).toThrow(/Invalid authentication payload tag/);
    }
  });
});

describe('grouping and scopes', () => {
  test('the grouping key separates destinations and methods', () => {
    const keys = [
      authenticationKey(parse(http('https://api.test/a'))!),
      authenticationKey(parse(http('https://api.test/b'))!),
      authenticationKey(parse(http(undefined, { tags: [['u', 'https://api.test/login'], ['method', 'GET']] }))!),
      authenticationKey(parse(http())!),
      authenticationKey(parse(relay())!),
    ];
    expect(new Set(keys).size).toBe(5);
  });

  test('the grouping key is the signed URL, not the canonical destination', () => {
    // Two spellings of one origin are two review groups: the prompt shows what was signed.
    expect(authenticationKey(parse(http('https://API.TEST/login'))!)).not.toBe(
      authenticationKey(parse(http('https://api.test/login'))!),
    );
  });

  test('connected-sites is a relay scope only', () => {
    const relayAuth = parse(relay())!;
    const httpAuth = parse(http())!;
    expect(validAuthenticationScope(relayAuth, 'connected-sites')).toBe(true);
    expect(validAuthenticationScope(httpAuth, 'connected-sites')).toBe(false);
    for (const auth of [relayAuth, httpAuth]) {
      expect(validAuthenticationScope(auth, 'once')).toBe(true);
      expect(validAuthenticationScope(auth, 'site')).toBe(true);
      for (const scope of [undefined, null, '', 'always', 'SITE', true, {}]) {
        expect(validAuthenticationScope(auth, scope)).toBe(false);
      }
    }
  });
});

describe('under a URL implementation that is not WHATWG', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * React Native's `URL` (0.86, `Libraries/Blob/URL.js`) slices the input with regexes: no
   * lowercasing, no default-port folding, no credential parsing. The repository's own lint rule
   * bans `URL` in the shared packages for this reason; this is the runtime half of that ban.
   */
  test('every canonicalisation and rejection still holds, and URL is never consulted', () => {
    const naive = vi.fn((input: string) => ({
      href: input,
      origin: input,
      protocol: `${input.split(':')[0]}:`,
      hostname: input.replace(/^[a-z]+:\/\//i, '').split(/[:/?#]/)[0],
      username: '',
      password: '',
    }));
    vi.stubGlobal('URL', naive);

    expect(parse(http('https://API.TEST:443/login'))!.destination).toBe('https://api.test');
    expect(parse(relay('wss://RELAY.TEST:443'))!.destination).toBe('wss://relay.test/');
    expect(() => parse(http('https://user:pw@api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http('http://api.test/login'))).toThrow(/Invalid authentication destination/);
    expect(() => parse(http(), 'https://CLIENT.TEST')).toThrow(/Invalid authentication destination/);
    expect(naive).not.toHaveBeenCalled();
  });
});
