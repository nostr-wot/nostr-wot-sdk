/**
 * Requesters that are not web pages: a NIP-46 client, an Android package, a LAN peer, the host
 * app itself. What this suite holds:
 *
 *   1. a non-web requester can never claim an origin: an `origin` or `client-origin` tag refuses
 *      the event, legacy login is refused, and the request is cross-origin for both protocols;
 *   2. the key a grant is stored under can never collide with a web origin, in either
 *      direction, whatever the identifier holds;
 *   3. the grant store reads and writes non-web keys unchanged, honours the shared `*` sentinel
 *      for them, and the record it writes is byte for byte the record a host already keeping its
 *      own list has written, so the list migrates with nothing lost;
 *   4. the web path is untouched: an object `web` requester is the string path, result for
 *      result and error for error.
 */
import { describe, expect, test } from 'vitest';
import { MemoryStore } from '@nostr-wot/storage';
import {
  AUTHENTICATION_DENIED_ERROR,
  AUTHENTICATION_GRANTS_KEY,
  AUTHENTICATION_REQUESTER_KINDS,
  AuthenticationDeniedError,
  AuthenticationGrants,
  ENDPOINT_GRANT_VERSION,
  NIP42_KIND,
  NIP98_KIND,
  NON_WEB_REQUESTER_KINDS,
  SHARED_SITES_ORIGIN,
  authenticationRequesterKey,
  canonicalHttpOrigin,
  parseAuthentication,
  storageLabel,
  type AuthenticationEventInput,
  type AuthenticationGrant,
  type AuthenticationRequester,
} from '../src/index.js';

const NOW = 1_700_000_000;
const SITE = 'https://client.test';
const PUBKEY = 'ab'.repeat(32);

const ANDROID: AuthenticationRequester = { kind: 'nip55', packageName: 'com.example.client' };
const CLIENT: AuthenticationRequester = { kind: 'nip46', clientPubkey: PUBKEY };
const PEER: AuthenticationRequester = { kind: 'lan', peerId: 'peer-1' };
const APP: AuthenticationRequester = { kind: 'local', id: 'nostr-wot-wallet' };
const NON_WEB = [ANDROID, CLIENT, PEER, APP];

function relay(url = 'wss://relay.test/', extra: Partial<AuthenticationEventInput> = {}): AuthenticationEventInput {
  return { kind: NIP42_KIND, content: '', created_at: NOW, tags: [['relay', url], ['challenge', 'c']], ...extra };
}

function http(url = 'https://api.test/login', extra: Partial<AuthenticationEventInput> = {}): AuthenticationEventInput {
  return { kind: NIP98_KIND, content: '', created_at: NOW, tags: [['u', url], ['method', 'POST']], ...extra };
}

describe('the key a non-web requester is stored under', () => {
  test('is kind:identifier, spelled as the signer pipeline spells a permission origin', () => {
    expect(authenticationRequesterKey(ANDROID)).toBe('nip55:com.example.client');
    expect(authenticationRequesterKey(CLIENT)).toBe(`nip46:${PUBKEY}`);
    expect(authenticationRequesterKey(PEER)).toBe('lan:peer-1');
    expect(authenticationRequesterKey(APP)).toBe('local:nostr-wot-wallet');
  });

  test('a web requester is its canonical origin, exactly the label the grant store already keys on', () => {
    expect(authenticationRequesterKey({ kind: 'web', origin: SITE })).toBe(SITE);
    expect(authenticationRequesterKey({ kind: 'web', origin: SITE })).toBe(storageLabel(SITE));
  });

  test('a web origin that is not already canonical is refused, not folded', () => {
    for (const origin of ['https://CLIENT.test', 'https://client.test:443', 'client.test', 'https://client.test/', '']) {
      expect(() => authenticationRequesterKey({ kind: 'web', origin })).toThrow('Invalid authentication requester');
    }
  });

  test('a NIP-46 client key is folded to lowercase and must be 32 hex bytes', () => {
    expect(authenticationRequesterKey({ kind: 'nip46', clientPubkey: 'AB'.repeat(32) })).toBe(`nip46:${PUBKEY}`);
    for (const clientPubkey of ['ab'.repeat(31), 'zz'.repeat(32), '', `${PUBKEY} `]) {
      expect(() => authenticationRequesterKey({ kind: 'nip46', clientPubkey })).toThrow('Invalid authentication requester');
    }
  });

  test('an empty, padded or control-character identifier is refused for every non-web kind', () => {
    const bad = ['', ' com.example', 'com.example ', 'com.\u0000example', 'a\nb', '\u007f'];
    for (const value of bad) {
      expect(() => authenticationRequesterKey({ kind: 'nip55', packageName: value })).toThrow('Invalid authentication requester');
      expect(() => authenticationRequesterKey({ kind: 'lan', peerId: value })).toThrow('Invalid authentication requester');
      expect(() => authenticationRequesterKey({ kind: 'local', id: value })).toThrow('Invalid authentication requester');
    }
  });

  test('an unknown kind is refused', () => {
    expect(() => authenticationRequesterKey({ kind: 'evil', id: 'x' } as unknown as AuthenticationRequester)).toThrow(
      'Invalid authentication requester',
    );
  });

  test('the signature digest of an Android caller is carried, never keyed', () => {
    const bare = authenticationRequesterKey(ANDROID);
    expect(authenticationRequesterKey({ ...ANDROID, kind: 'nip55', signatureDigest: 'ff'.repeat(32) })).toBe(bare);
  });

  test('no non-web key is a web origin, the shared sentinel, or folded by the store, whatever the identifier', () => {
    // Identifiers chosen to look like a web key or the sentinel if the prefix were ever lost.
    const hostile = ['https://client.test', 'http://localhost', 'client.test', '*', 'https://client.test:443', '[::1]'];
    for (const identifier of hostile) {
      const requesters: AuthenticationRequester[] = [
        { kind: 'nip55', packageName: identifier },
        { kind: 'lan', peerId: identifier },
        { kind: 'local', id: identifier },
      ];
      for (const requester of requesters) {
        const key = authenticationRequesterKey(requester);
        expect(canonicalHttpOrigin(key)).toBeNull();
        expect(key).not.toBe(SHARED_SITES_ORIGIN);
        expect(key.startsWith('http://') || key.startsWith('https://')).toBe(false);
        // The grant store folds a web origin through `storageLabel`; a non-web key passes through.
        expect(storageLabel(key)).toBe(key);
      }
    }
  });

  test('no web key begins with a non-web kind prefix, and the kind lists agree', () => {
    for (const origin of [SITE, 'http://localhost:3000', 'https://nip55.test', 'https://lan']) {
      const key = authenticationRequesterKey({ kind: 'web', origin });
      for (const kind of NON_WEB_REQUESTER_KINDS) expect(key.startsWith(`${kind}:`)).toBe(false);
    }
    expect(AUTHENTICATION_REQUESTER_KINDS).toEqual(['web', ...NON_WEB_REQUESTER_KINDS]);
  });
});

describe('a non-web requester cannot claim an origin', () => {
  test('a relay or HTTP credential parses, canonical destination, cross-origin for both protocols', () => {
    for (const requester of NON_WEB) {
      expect(parseAuthentication(relay('wss://RELAY.test:443/room'), requester, NOW)).toEqual({
        protocol: 'nip42',
        url: 'wss://RELAY.test:443/room',
        destination: 'wss://relay.test/room',
        crossOrigin: true,
      });
      expect(parseAuthentication(http('https://API.test/login?x=1'), requester, NOW)).toEqual({
        protocol: 'nip98',
        url: 'https://API.test/login?x=1',
        destination: 'https://api.test',
        method: 'POST',
        crossOrigin: true,
      });
    }
  });

  test('an origin or client-origin tag is a contradiction and refuses the event, whatever it says', () => {
    for (const requester of NON_WEB) {
      for (const name of ['origin', 'client-origin']) {
        for (const value of ['https://client.test', 'com.example.client', authenticationRequesterKey(requester), '']) {
          const withTag = (event: AuthenticationEventInput) => ({ ...event, tags: [...event.tags, [name, value]] });
          expect(() => parseAuthentication(withTag(relay()), requester, NOW)).toThrow(`Invalid authentication ${name} tag`);
          expect(() => parseAuthentication(withTag(http()), requester, NOW)).toThrow(`Invalid authentication ${name} tag`);
        }
      }
    }
  });

  test('legacy domain login is refused for a non-web requester even when the host has an allowlist', () => {
    const legacy: AuthenticationEventInput = { kind: NIP42_KIND, content: '', created_at: NOW, tags: [['domain', 'client.test'], ['challenge', 'c']] };
    // The same event is accepted for the allowlisted site, so the refusal is about the requester.
    expect(parseAuthentication(legacy, SITE, NOW, { legacyLoginOrigins: [SITE] })).toMatchObject({ protocol: 'legacy-login' });
    for (const requester of NON_WEB) {
      expect(() => parseAuthentication(legacy, requester, NOW, { legacyLoginOrigins: [SITE] })).toThrow(
        'Invalid legacy authentication domain or format',
      );
    }
  });

  test('a malformed requester is refused before the event is read', () => {
    const broken = { ...http(), tags: [['method', 'POST']] };
    // With a valid requester this event is refused for its missing `u` tag...
    expect(() => parseAuthentication(broken, ANDROID, NOW)).toThrow('Invalid authentication u tag');
    // ...with a malformed one, the requester is what is refused.
    expect(() => parseAuthentication(broken, { kind: 'nip55', packageName: '' }, NOW)).toThrow('Invalid authentication requester');
    expect(() => parseAuthentication(broken, { kind: 'nip46', clientPubkey: 'nope' }, NOW)).toThrow('Invalid authentication requester');
  });

  test('every destination refusal the web path makes is made for a non-web requester too', () => {
    for (const requester of NON_WEB) {
      for (const url of ['ws://relay.test', 'https://relay.test', 'wss://relay.test/#frag', 'wss://user@relay.test', ' wss://relay.test']) {
        expect(() => parseAuthentication(relay(url), requester, NOW)).toThrow('Invalid authentication destination');
      }
      for (const url of ['http://api.test/login', 'wss://api.test/login', 'https://api.test/login#frag']) {
        expect(() => parseAuthentication(http(url), requester, NOW)).toThrow('Invalid authentication destination');
      }
      expect(() => parseAuthentication(relay('wss://relay.test', { created_at: NOW - 601 }), requester, NOW)).toThrow('Invalid authentication timestamp');
      expect(() => parseAuthentication(http('https://api.test/login', { content: 'x' }), requester, NOW)).toThrow('Invalid authentication content');
    }
  });

  test('an ordinary event is not an authentication event for any requester', () => {
    for (const requester of [...NON_WEB, SITE, { kind: 'web', origin: SITE } as const]) {
      expect(parseAuthentication({ kind: 1, content: 'hi', created_at: NOW, tags: [] }, requester, NOW)).toBeUndefined();
    }
  });
});

describe('the web path is the web path', () => {
  test('an object web requester parses exactly as the string form does', () => {
    const asObject = { kind: 'web', origin: SITE } as const;
    const withTag = (event: AuthenticationEventInput) => ({ ...event, tags: [...event.tags, ['origin', SITE]] });
    for (const event of [relay(), http(), http('https://client.test/api'), withTag(relay()), withTag(http())]) {
      expect(parseAuthentication(event, asObject, NOW)).toEqual(parseAuthentication(event, SITE, NOW));
    }
    // Same-origin stays recognisable for a page, which is the one thing a non-web requester can never be.
    expect(parseAuthentication(http('https://client.test/api'), asObject, NOW)?.crossOrigin).toBe(false);
  });

  test('an object web requester is refused with the same error as the string form', () => {
    for (const origin of ['https://CLIENT.test', 'client.test', 'http://client.test']) {
      expect(() => parseAuthentication(relay(), { kind: 'web', origin }, NOW)).toThrow('Invalid authentication destination');
      expect(() => parseAuthentication(relay(), origin, NOW)).toThrow('Invalid authentication destination');
    }
    const lying = { ...http(), tags: [...http().tags, ['origin', 'https://other.test']] };
    expect(() => parseAuthentication(lying, { kind: 'web', origin: SITE }, NOW)).toThrow('Invalid authentication origin tag');
    expect(() => parseAuthentication(lying, SITE, NOW)).toThrow('Invalid authentication origin tag');
  });
});

describe('grants for a non-web requester', () => {
  const ACCOUNT = 'acct_1';
  const current = (): void => {};

  function fresh(seed: Record<string, unknown> = {}) {
    const store = new MemoryStore(seed);
    return { store, grants: new AuthenticationGrants(store) };
  }

  test('a site-scoped grant answers that requester, that destination, and no other requester', async () => {
    const { grants } = fresh();
    const android = authenticationRequesterKey(ANDROID);
    const auth = parseAuthentication(relay(), ANDROID, NOW)!;
    await grants.save(ACCOUNT, android, auth, 'site', current);
    expect(await grants.decisionFor(ACCOUNT, android, auth)).toBe('allow');
    expect(await grants.decisionFor(ACCOUNT, 'nip55:com.example.other', auth)).toBeUndefined();
    expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(CLIENT), auth)).toBeUndefined();
    expect(await grants.decisionFor(ACCOUNT, android, parseAuthentication(relay('wss://other.test'), ANDROID, NOW)!)).toBeUndefined();
    expect(await grants.decisionFor('acct_2', android, auth)).toBeUndefined();
  });

  test('an HTTP grant binds the exact signed URL and method for a non-web requester', async () => {
    const { grants } = fresh();
    const client = authenticationRequesterKey(CLIENT);
    await grants.save(ACCOUNT, client, parseAuthentication(http('https://api.test/login'), CLIENT, NOW)!, 'site', current);
    expect(await grants.decisionFor(ACCOUNT, client, parseAuthentication(http('https://api.test/login'), CLIENT, NOW)!)).toBe('allow');
    expect(await grants.decisionFor(ACCOUNT, client, parseAuthentication(http('https://api.test/transfer'), CLIENT, NOW)!)).toBeUndefined();
    expect(await grants.decisionFor(ACCOUNT, client, parseAuthentication(http('https://api.test/login', { tags: [['u', 'https://api.test/login'], ['method', 'GET']] }), CLIENT, NOW)!)).toBeUndefined();
    // Every requester on the device is not a scope an HTTP credential can be remembered at.
    await expect(grants.save(ACCOUNT, client, parseAuthentication(http(), CLIENT, NOW)!, 'connected-sites', current)).rejects.toThrow('Invalid authentication scope');
  });

  test('a relay grant for every caller is honoured for every requester kind, and a caller deny still wins', async () => {
    const { grants } = fresh();
    const auth = parseAuthentication(relay(), ANDROID, NOW)!;
    await grants.save(ACCOUNT, authenticationRequesterKey(ANDROID), auth, 'connected-sites', current);
    for (const requester of [...NON_WEB, { kind: 'web', origin: SITE } as const]) {
      expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(requester), auth)).toBe('allow');
    }
    await grants.save(ACCOUNT, authenticationRequesterKey(PEER), auth, 'site', current, 'deny');
    expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(PEER), auth)).toBe('deny');
    expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(ANDROID), auth)).toBe('allow');
    // And an allow saved after the deny does not erase it.
    await expect(grants.save(ACCOUNT, authenticationRequesterKey(PEER), auth, 'site', current)).rejects.toMatchObject({
      name: AUTHENTICATION_DENIED_ERROR,
      message: 'Authentication permission denied',
    });
    expect(new AuthenticationDeniedError()).toBeInstanceOf(Error);
  });

  test('revoking one non-web requester removes its grants and nothing else', async () => {
    const { grants } = fresh();
    const auth = parseAuthentication(relay(), ANDROID, NOW)!;
    await grants.save(ACCOUNT, authenticationRequesterKey(ANDROID), auth, 'site', current);
    await grants.save(ACCOUNT, authenticationRequesterKey(CLIENT), auth, 'site', current);
    await grants.save(ACCOUNT, authenticationRequesterKey(APP), auth, 'connected-sites', current);
    await grants.revoke({ origin: authenticationRequesterKey(ANDROID) });
    const left = (await grants.list()).map((grant) => grant.origin).sort();
    expect(left).toEqual([SHARED_SITES_ORIGIN, authenticationRequesterKey(CLIENT)].sort());
  });

  test('the record written is the record a host already keeping its own list has written', async () => {
    const { store, grants } = fresh();
    const android = authenticationRequesterKey(ANDROID);
    const relayAuth = parseAuthentication(relay('wss://relay.test/room'), ANDROID, NOW)!;
    const httpAuth = parseAuthentication(http('https://api.test/login?x=1'), ANDROID, NOW)!;
    await grants.save(ACCOUNT, android, relayAuth, 'site', current);
    await grants.save(ACCOUNT, android, httpAuth, 'site', current, 'deny');
    await grants.save(ACCOUNT, android, relayAuth, 'connected-sites', current);
    const written = await store.get<AuthenticationGrant[]>(AUTHENTICATION_GRANTS_KEY);
    // The host's `authenticationGrantId`: JSON of [account, origin, protocol, scope, method].
    expect(written).toEqual([
      {
        decision: 'allow',
        accountId: ACCOUNT,
        origin: android,
        protocol: 'nip42',
        destination: 'wss://relay.test/room',
        id: JSON.stringify([ACCOUNT, android, 'nip42', 'wss://relay.test/room', '']),
      },
      {
        decision: 'deny',
        accountId: ACCOUNT,
        origin: android,
        protocol: 'nip98',
        destination: 'https://api.test',
        version: ENDPOINT_GRANT_VERSION,
        resource: 'https://api.test/login?x=1',
        method: 'POST',
        id: JSON.stringify([ACCOUNT, android, 'nip98', 'https://api.test/login?x=1', 'POST']),
      },
      {
        decision: 'allow',
        accountId: ACCOUNT,
        origin: SHARED_SITES_ORIGIN,
        protocol: 'nip42',
        destination: 'wss://relay.test/room',
        id: JSON.stringify([ACCOUNT, SHARED_SITES_ORIGIN, 'nip42', 'wss://relay.test/room', '']),
      },
    ]);
  });

  test('a list a host wrote is read as-is: nothing is lost on migration', async () => {
    const android = authenticationRequesterKey(ANDROID);
    const seeded: AuthenticationGrant[] = [
      { decision: 'allow', id: JSON.stringify([ACCOUNT, android, 'nip42', 'wss://relay.test/', '']), accountId: ACCOUNT, origin: android, protocol: 'nip42', destination: 'wss://relay.test/' },
      { decision: 'allow', id: JSON.stringify([ACCOUNT, android, 'nip98', 'https://api.test/login', 'POST']), accountId: ACCOUNT, origin: android, protocol: 'nip98', destination: 'https://api.test', method: 'POST', version: ENDPOINT_GRANT_VERSION, resource: 'https://api.test/login' },
      { decision: 'deny', id: JSON.stringify([ACCOUNT, `nip46:${PUBKEY}`, 'nip42', 'wss://relay.test/', '']), accountId: ACCOUNT, origin: `nip46:${PUBKEY}`, protocol: 'nip42', destination: 'wss://relay.test/' },
      // A legacy HTTP allow, no version: never honoured again, still listed.
      { id: 'legacy', accountId: ACCOUNT, origin: 'lan:peer-1', protocol: 'nip98', destination: 'https://api.test', method: 'POST' },
    ];
    const { grants } = fresh({ [AUTHENTICATION_GRANTS_KEY]: seeded });
    expect(await grants.decisionFor(ACCOUNT, android, parseAuthentication(relay(), ANDROID, NOW)!)).toBe('allow');
    expect(await grants.decisionFor(ACCOUNT, android, parseAuthentication(http(), ANDROID, NOW)!)).toBe('allow');
    expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(CLIENT), parseAuthentication(relay(), CLIENT, NOW)!)).toBe('deny');
    expect(await grants.decisionFor(ACCOUNT, authenticationRequesterKey(PEER), parseAuthentication(http(), PEER, NOW)!)).toBeUndefined();
    expect(await grants.list()).toEqual(seeded);
  });

  test('an asynchronous assertCurrent is awaited inside the lock, and its rejection writes nothing', async () => {
    const { store, grants } = fresh();
    const auth = parseAuthentication(relay(), ANDROID, NOW)!;
    let checked = 0;
    await expect(
      grants.save(ACCOUNT, authenticationRequesterKey(ANDROID), auth, 'site', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        checked += 1;
        throw new Error('Account switched');
      }),
    ).rejects.toThrow('Account switched');
    expect(checked).toBe(1);
    expect(await store.get(AUTHENTICATION_GRANTS_KEY)).toBeUndefined();
  });
});
