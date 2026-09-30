/**
 * The stored half of the destination model.
 *
 * The three ordering properties get a test each, because each is a separate way the same
 * credential leaks and passing two of the three tells you nothing about the third:
 *
 *   1. deny wins over a shared relay allow,
 *   2. the `*` origin is honoured for NIP-42 and for nothing else,
 *   3. an approval that waited for the lock re-checks for a deny instead of overwriting it.
 *
 * The rest covers what the five-field match refuses, the storage key an extension already
 * wrote, and the revocation paths `Permissions` must not be able to forget.
 */
import { describe, test, expect } from 'vitest';
import { MemoryStore, type KeyValueStore } from '@nostr-wot/storage';
import {
  AUTHENTICATION_GRANTS_KEY,
  AuthenticationGrants,
  ENDPOINT_GRANT_VERSION,
  NIP42_KIND,
  NIP98_KIND,
  Permissions,
  SHARED_SITES_ORIGIN,
  parseAuthentication,
  type AuthenticationGrant,
  type AuthenticationRequest,
} from '../src/index.js';

const SITE = 'https://client.test';
const OTHER = 'https://other.test';
const NOW = 1_700_000_000;
/** No account or session moved; the host's check is exercised on its own further down. */
const current = (): void => {};

function relayAuth(url = 'wss://relay.test/'): AuthenticationRequest {
  return parseAuthentication(
    { kind: NIP42_KIND, content: '', created_at: NOW, tags: [['relay', url], ['challenge', 'c']] },
    SITE,
    NOW,
  )!;
}

function httpAuth(url = 'https://api.test/login', method = 'POST'): AuthenticationRequest {
  return parseAuthentication(
    { kind: NIP98_KIND, content: '', created_at: NOW, tags: [['u', url], ['method', method]] },
    SITE,
    NOW,
  )!;
}

function fresh(seed: Record<string, unknown> = {}): { store: MemoryStore; grants: AuthenticationGrants } {
  const store = new MemoryStore(seed);
  return { store, grants: new AuthenticationGrants(store) };
}

async function stored(store: KeyValueStore): Promise<AuthenticationGrant[]> {
  return (await store.get<AuthenticationGrant[]>(AUTHENTICATION_GRANTS_KEY)) ?? [];
}

describe('storage compatibility with the browser extension', () => {
  test('the storage key is the one the extension already wrote', () => {
    expect(AUTHENTICATION_GRANTS_KEY).toBe('authenticationGrants');
    expect(SHARED_SITES_ORIGIN).toBe('*');
  });

  test('an existing extension blob is read as-is, and a missing decision means allow', async () => {
    const { grants } = fresh({
      authenticationGrants: [
        {
          id: 'legacy',
          accountId: 'acct1',
          origin: SITE,
          protocol: 'nip42',
          destination: 'wss://relay.test/',
        },
      ],
    });
    expect(await grants.decisionFor('acct1', SITE, relayAuth())).toBe('allow');
  });

  test('a stored value that is not an array authorises nothing rather than throwing', async () => {
    for (const junk of [null, 0, 'grants', { id: 'x' }]) {
      const { grants } = fresh({ authenticationGrants: junk });
      await expect(grants.list()).resolves.toEqual([]);
      await expect(grants.decisionFor('acct1', SITE, relayAuth())).resolves.toBeUndefined();
    }
  });
});

describe('a grant binds all five of account, site, protocol, destination and method', () => {
  test('nothing stored means nothing decided', async () => {
    const { grants } = fresh();
    expect(await grants.decisionFor('acct1', SITE, relayAuth())).toBeUndefined();
    expect(await grants.isAllowed('acct1', SITE, relayAuth())).toBe(false);
  });

  test('a site grant answers only that account, site, destination and method', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);

    expect(await grants.isAllowed('acct1', SITE, httpAuth())).toBe(true);
    expect(await grants.isAllowed('acct2', SITE, httpAuth())).toBe(false);
    expect(await grants.isAllowed('acct1', OTHER, httpAuth())).toBe(false);
    // A different port is a different service, and a different method a different act.
    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api.test:8443/login'))).toBe(false);
    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api.test/login', 'GET'))).toBe(false);
  });

  test('a NIP-98 grant binds the exact signed URL, not the service origin', async () => {
    // A user shown `POST https://api.test/login` did not consent to `POST /transfer`, and an
    // origin-wide HTTP consent answered both. Query bytes count too: they are not normalised or
    // sorted, so a different query is a different resource and asks again.
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth('https://api.test/login'), 'site', current);

    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api.test/login'))).toBe(true);
    for (const url of [
      'https://api.test/transfer',
      'https://api.test/',
      'https://api.test/login?x=1',
      'https://API.TEST/login',
    ]) {
      expect(await grants.isAllowed('acct1', SITE, httpAuth(url))).toBe(false);
    }
  });

  test('two endpoints on one origin are two records, not one overwriting the other', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, httpAuth('https://api.test/login'), 'site', current);
    await grants.save('acct1', SITE, httpAuth('https://api.test/refresh'), 'site', current);
    expect(await stored(store)).toHaveLength(2);
    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api.test/login'))).toBe(true);
    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api.test/refresh'))).toBe(true);
  });

  test('a NIP-98 record carries the endpoint version and keeps the origin for display', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, httpAuth('https://api.test/login?next=%2F'), 'site', current);
    const [grant] = await stored(store);
    expect(grant).toMatchObject({
      version: 2,
      resource: 'https://api.test/login?next=%2F',
      destination: 'https://api.test',
      method: 'POST',
    });
    expect(ENDPOINT_GRANT_VERSION).toBe(2);
  });

  test('a NIP-42 record carries neither field, because its destination IS the endpoint', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, relayAuth('wss://relay.test/team-a'), 'site', current);
    const [grant] = await stored(store);
    expect(grant!.version).toBeUndefined();
    expect(grant!.resource).toBeUndefined();
    expect(grant!.destination).toBe('wss://relay.test/team-a');
  });

  describe('a legacy NIP-98 record, written before endpoint scoping', () => {
    /** An origin-wide HTTP record: no version, no resource. */
    function legacy(decision?: 'allow' | 'deny'): Record<string, unknown> {
      const auth = httpAuth();
      return {
        id: 'legacy-http',
        ...(decision ? { decision } : {}),
        accountId: 'acct1',
        origin: SITE,
        protocol: auth.protocol,
        destination: auth.destination,
        method: auth.method,
      };
    }

    test('its allow is never honoured again, so the user is asked at the narrower scope', async () => {
      for (const record of [legacy('allow'), legacy()]) {
        const { grants } = fresh({ authenticationGrants: [record] });
        // Not even for the URL it was presumably written from: an origin-wide consent is not
        // an endpoint consent, and reinterpreting it as one would grant what nobody gave.
        expect(await grants.decisionFor('acct1', SITE, httpAuth())).toBeUndefined();
        expect(await grants.decisionFor('acct1', SITE, httpAuth('https://api.test/transfer'))).toBeUndefined();
        // It stays listed, so it is still visible and revocable rather than quietly dropped.
        expect(await grants.list()).toHaveLength(1);
      }
    });

    test('its deny keeps the broad reach it was written with', async () => {
      // Narrowing a refusal is the one direction that loses protection.
      const { grants } = fresh({ authenticationGrants: [legacy('deny')] });
      expect(await grants.decisionFor('acct1', SITE, httpAuth())).toBe('deny');
      expect(await grants.decisionFor('acct1', SITE, httpAuth('https://api.test/transfer'))).toBe('deny');
      // Still bound to the method and the account, which were always part of the record.
      expect(await grants.decisionFor('acct1', SITE, httpAuth('https://api.test/x', 'GET'))).toBeUndefined();
      expect(await grants.decisionFor('acct2', SITE, httpAuth())).toBeUndefined();
    });

    test('a legacy deny still beats a fresh endpoint allow for the same URL', async () => {
      const { grants } = fresh({ authenticationGrants: [legacy('deny')] });
      await expect(
        grants.save('acct1', SITE, httpAuth(), 'site', current),
      ).rejects.toThrow(/Authentication permission denied/);
    });
  });

  test('a relay grant keeps path, port and query apart', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, relayAuth('wss://relay.test/team-a'), 'site', current);
    for (const url of ['wss://relay.test/team-b', 'wss://relay.test:8443/team-a', 'wss://relay.test/team-a?t=b']) {
      expect(await grants.isAllowed('acct1', SITE, relayAuth(url))).toBe(false);
    }
    expect(await grants.isAllowed('acct1', SITE, relayAuth('wss://relay.test/team-a'))).toBe(true);
  });

  test('a NIP-98 grant does not answer a NIP-42 request for the same host', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth('https://relay.test/'), 'site', current);
    expect(await grants.isAllowed('acct1', SITE, relayAuth('wss://relay.test/'))).toBe(false);
  });

  test('a record whose protocol disagrees with its destination answers nothing', async () => {
    // The two scheme sets never overlap, so a grant this package WROTE can never carry a
    // NIP-98 protocol beside a `wss://` destination. Stored data can: a hand edit, an older
    // build, a merge. Without the protocol comparison such a record answers a NIP-42 request,
    // and paired with the `*` origin it answers one from every site at once.
    const auth = relayAuth();
    const { grants } = fresh({
      authenticationGrants: [
        {
          id: 'mismatched',
          decision: 'allow',
          accountId: 'acct1',
          origin: SHARED_SITES_ORIGIN,
          protocol: 'nip98',
          destination: auth.destination,
        },
      ],
    });
    expect(await grants.decisionFor('acct1', SITE, auth)).toBeUndefined();
    expect(await grants.decisionFor('acct1', OTHER, auth)).toBeUndefined();
  });

  test('a non-canonical origin is folded on LOOKUP as well as on save', async () => {
    // Defence in depth. `parseAuthentication` already refuses a non-canonical requester, so a
    // host on that path cannot get here with one; a host calling the grant store directly can,
    // and a lookup that missed would prompt again for a site the user had already answered.
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    expect(await grants.isAllowed('acct1', 'https://CLIENT.TEST:443', httpAuth())).toBe(true);
  });

  test('re-saving the same grant replaces it rather than accumulating duplicates', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, relayAuth(), 'site', current);
    await grants.save('acct1', SITE, relayAuth(), 'site', current);
    expect(await stored(store)).toHaveLength(1);
  });

  test('a once consent stores nothing at all', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'once', current);
    expect(await stored(store)).toEqual([]);
    expect(await grants.isAllowed('acct1', SITE, httpAuth())).toBe(false);
  });

  test('an empty account id or origin is refused rather than stored', async () => {
    const { grants } = fresh();
    await expect(grants.save('', SITE, httpAuth(), 'site', current)).rejects.toThrow(/account id must not be empty/);
    await expect(grants.save('acct1', '', httpAuth(), 'site', current)).rejects.toThrow(/origin must not be empty/);
  });

  test('a scope this request could not have is refused', async () => {
    const { grants } = fresh();
    await expect(
      grants.save('acct1', SITE, httpAuth(), 'connected-sites', current),
    ).rejects.toThrow(/Invalid authentication scope/);
    await expect(
      grants.save('acct1', SITE, relayAuth(), 'always' as never, current),
    ).rejects.toThrow(/Invalid authentication scope/);
  });

  test('a denial is only ever site-scoped', async () => {
    const { grants } = fresh();
    for (const scope of ['once', 'connected-sites'] as const) {
      await expect(
        grants.save('acct1', SITE, relayAuth(), scope, current, 'deny'),
      ).rejects.toThrow(/Invalid authentication denial scope/);
    }
    await expect(grants.save('acct1', SITE, relayAuth(), 'site', current, 'deny')).resolves.toBeUndefined();
  });

  test('the host\'s own check runs inside the lock and its throw stores nothing', async () => {
    const { store, grants } = fresh();
    await expect(
      grants.save('acct1', SITE, relayAuth(), 'site', () => {
        throw new Error('Account switched');
      }),
    ).rejects.toThrow(/Account switched/);
    expect(await stored(store)).toEqual([]);
  });

  test('a non-canonical origin is folded, so a revocation by site still finds the grant', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', 'https://CLIENT.TEST:443', httpAuth(), 'site', current);
    expect((await stored(store))[0]!.origin).toBe(SITE);
    expect(await grants.isAllowed('acct1', SITE, httpAuth())).toBe(true);
  });
});

describe('property 1: a site deny beats a shared relay allow', () => {
  test('a shared relay allow plus a site deny resolves to deny for that site only', async () => {
    const { grants } = fresh();
    const auth = relayAuth();
    await grants.save('acct1', SITE, auth, 'connected-sites', current);
    await grants.save('acct1', SITE, auth, 'site', current, 'deny');

    expect(await grants.decisionFor('acct1', SITE, auth)).toBe('deny');
    // The shared allow survives for every other site, which is the point of scoping the deny.
    expect(await grants.decisionFor('acct1', OTHER, auth)).toBe('allow');
    // And it is still bound to the account and the destination.
    expect(await grants.decisionFor('acct2', SITE, auth)).toBeUndefined();
    expect(await grants.decisionFor('acct1', SITE, relayAuth('wss://another.test/'))).toBeUndefined();
  });

  test('the order the two are written in does not change the answer', async () => {
    const { grants } = fresh();
    const auth = relayAuth();
    await grants.save('acct1', SITE, auth, 'site', current, 'deny');
    // The shared allow is for `*`, so it is not the record the deny check matches on... it is.
    await expect(
      grants.save('acct1', SITE, auth, 'connected-sites', current),
    ).rejects.toThrow(/Authentication permission denied/);
    expect(await grants.decisionFor('acct1', SITE, auth)).toBe('deny');
  });

  test('only an explicit revocation lifts a deny', async () => {
    const { grants } = fresh();
    const auth = relayAuth();
    await grants.save('acct1', SITE, auth, 'site', current, 'deny');
    const deny = (await grants.list()).find((grant) => grant.decision === 'deny')!;
    await grants.revoke({ id: deny.id });
    expect(await grants.decisionFor('acct1', SITE, auth)).toBeUndefined();
  });
});

describe('property 2: the shared-sites origin is honoured for NIP-42 and nothing else', () => {
  test('a connected-sites relay grant answers for every site', async () => {
    const { store, grants } = fresh();
    await grants.save('acct1', SITE, relayAuth(), 'connected-sites', current);
    expect((await stored(store))[0]!.origin).toBe(SHARED_SITES_ORIGIN);
    expect(await grants.isAllowed('acct1', OTHER, relayAuth())).toBe(true);
    expect(await grants.isAllowed('acct1', 'https://third.test', relayAuth())).toBe(true);
  });

  test('a hand-written or legacy `*` record for NIP-98 is NOT honoured', async () => {
    // `validAuthenticationScope` stops one being created. This is the other guard: data already
    // on disk, written by a hand, an older build or a corrupted merge, must not become an HTTP
    // credential for every connected site. Only the read-side check can refuse that.
    const auth = httpAuth();
    const { grants } = fresh({
      authenticationGrants: [
        {
          id: 'smuggled',
          decision: 'allow',
          accountId: 'acct1',
          origin: SHARED_SITES_ORIGIN,
          protocol: auth.protocol,
          destination: auth.destination,
          method: auth.method,
        },
      ],
    });
    expect(await grants.decisionFor('acct1', OTHER, auth)).toBeUndefined();
    // Not even for the site the record was presumably written from.
    expect(await grants.decisionFor('acct1', SITE, auth)).toBeUndefined();
  });

  test('a `*` record is not a pattern: a literal comparison, never a wildcard match', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, relayAuth(), 'connected-sites', current);
    // If `*` were matched as a glob, a site-scoped read would also match a site-scoped grant
    // under some other origin. Only the sentinel matches.
    expect(await grants.decisionFor('acct1', OTHER, relayAuth('wss://relay.test/other'))).toBeUndefined();
  });

  test('disconnecting one site leaves a shared relay grant, clearing the account removes it', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, relayAuth(), 'connected-sites', current);
    await grants.revoke({ origin: SITE });
    expect(await grants.isAllowed('acct1', OTHER, relayAuth())).toBe(true);
    await grants.revoke({ accountId: 'acct1' });
    expect(await grants.isAllowed('acct1', OTHER, relayAuth())).toBe(false);
  });
});

describe('property 3: an approval that waited for the lock re-checks for a deny', () => {
  test('a rejection racing an approval wins, and the approval refuses rather than overwriting', async () => {
    const { grants } = fresh();
    const auth = httpAuth();
    // Both enter save() before either has written: the approval's read is behind the lock and
    // will be stale by the time it runs. Without the in-lock re-check it would write its allow
    // over the rejection the user had just made.
    const rejection = grants.save('acct1', SITE, auth, 'site', current, 'deny');
    const approval = grants.save('acct1', SITE, auth, 'site', current);

    await rejection;
    await expect(approval).rejects.toThrow(/Authentication permission denied/);
    expect(await grants.decisionFor('acct1', SITE, auth)).toBe('deny');
  });

  test('a once consent racing the same rejection is refused too, though it stores nothing', async () => {
    const { grants } = fresh();
    const auth = httpAuth();
    const rejection = grants.save('acct1', SITE, auth, 'site', current, 'deny');
    const once = grants.save('acct1', SITE, auth, 'once', current);
    await rejection;
    // `once` writes nothing, so there is nothing to overwrite -- but it still authorises this
    // one signature, and a standing deny has to refuse it.
    await expect(once).rejects.toThrow(/Authentication permission denied/);
  });

  test('a shared relay approval cannot overwrite a site rejection either', async () => {
    const { grants } = fresh();
    const auth = relayAuth();
    const rejection = grants.save('acct1', SITE, auth, 'site', current, 'deny');
    const approval = grants.save('acct1', SITE, auth, 'connected-sites', current);
    await rejection;
    await expect(approval).rejects.toThrow(/Authentication permission denied/);
  });

  test('two approvals for different destinations both survive a serialized write', async () => {
    const { store, grants } = fresh();
    await Promise.all([
      grants.save('acct1', SITE, httpAuth('https://api-a.test/login'), 'site', current),
      grants.save('acct1', SITE, httpAuth('https://api-b.test/login'), 'site', current),
    ]);
    // Without the lock the second read-modify-write would drop the first.
    expect(await stored(store)).toHaveLength(2);
  });

  test('a rejection racing a rejection leaves exactly one deny', async () => {
    const { store, grants } = fresh();
    const auth = httpAuth();
    await Promise.all([
      grants.save('acct1', SITE, auth, 'site', current, 'deny'),
      grants.save('acct1', SITE, auth, 'site', current, 'deny'),
    ]);
    expect(await stored(store)).toHaveLength(1);
    expect(await grants.decisionFor('acct1', SITE, auth)).toBe('deny');
  });
});

describe('revocation', () => {
  test('by id removes exactly one grant', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth('https://api-a.test/x'), 'site', current);
    await grants.save('acct1', SITE, httpAuth('https://api-b.test/x'), 'site', current);
    const [first] = await grants.list();
    await grants.revoke({ id: first!.id });
    expect(await grants.list()).toHaveLength(1);
    expect(await grants.isAllowed('acct1', SITE, httpAuth('https://api-b.test/x'))).toBe(true);
  });

  test('canonicalises the filter origin, so a host\'s casing cannot leave a credential behind', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    await grants.revoke({ origin: 'https://CLIENT.TEST:443' });
    expect(await grants.list()).toEqual([]);
  });

  test('by bare hostname finds an origin-keyed grant, which is the direction that can arise', async () => {
    // A grant is always STORED under a canonical origin (`storageLabel` on save), so there is
    // no hostname-keyed grant for an origin filter to have to find. The reverse is real: a host
    // whose disconnect path still speaks hostnames must not leave the credential behind.
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    await grants.revoke({ origin: 'client.test' });
    expect(await grants.list()).toEqual([]);
  });

  test('by site is scoped to that site and every account on it', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    await grants.save('acct2', SITE, httpAuth(), 'site', current);
    await grants.save('acct1', OTHER, httpAuth(), 'site', current);
    await grants.revoke({ origin: SITE });
    expect(await grants.list()).toHaveLength(1);
    expect(await grants.isAllowed('acct1', OTHER, httpAuth())).toBe(true);
  });

  test('site and account together remove only their intersection', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    await grants.save('acct2', SITE, httpAuth(), 'site', current);
    await grants.revoke({ origin: SITE, accountId: 'acct1' });
    expect(await grants.isAllowed('acct1', SITE, httpAuth())).toBe(false);
    expect(await grants.isAllowed('acct2', SITE, httpAuth())).toBe(true);
  });

  test('an empty string in a filter field throws instead of matching everything', async () => {
    // The dangerous default: every field is skipped when falsy, so `{ id: '' }` would match
    // every grant and delete the lot while reporting success. A UI reading an id off a list
    // item and getting an empty one would wipe a user's every remembered consent.
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    for (const filter of [{ id: '' }, { accountId: '' }, { origin: '' }]) {
      await expect(grants.revoke(filter)).rejects.toThrow(/must not be empty/);
    }
    expect(await grants.list()).toHaveLength(1);
  });

  test('an empty filter forgets every remembered decision', async () => {
    const { grants } = fresh();
    await grants.save('acct1', SITE, httpAuth(), 'site', current);
    await grants.save('acct2', OTHER, relayAuth(), 'connected-sites', current);
    await grants.revoke();
    expect(await grants.list()).toEqual([]);
  });
});

describe('Permissions cannot forget to revoke them', () => {
  /** A live grant for `acct1` on SITE, plus one on OTHER that must survive a site-scoped clear. */
  async function seededPermissions(): Promise<{ store: MemoryStore; permissions: Permissions }> {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, httpAuth(), 'site', current);
    await permissions.authentication.save('acct1', OTHER, httpAuth(), 'site', current);
    return { store, permissions };
  }

  test('a store gets one grant store, reachable from the permissions it shares a store with', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, httpAuth(), 'site', current);
    // Written under the extension's key in the same store, so a second reader sees it.
    expect(await new AuthenticationGrants(store).isAllowed('acct1', SITE, httpAuth())).toBe(true);
  });

  test('clearing one site\'s rules revokes that site\'s grants and no others', async () => {
    const { permissions } = await seededPermissions();
    await permissions.clear(SITE, 'acct1');
    expect(await permissions.authentication.isAllowed('acct1', SITE, httpAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct1', OTHER, httpAuth())).toBe(true);
  });

  test('clearing every rule for an account revokes every grant it held', async () => {
    const { permissions } = await seededPermissions();
    await permissions.clear(undefined, 'acct1');
    expect(await permissions.authentication.list()).toEqual([]);
  });

  test('disconnecting a site revokes its grants for every account', async () => {
    const { permissions } = await seededPermissions();
    await permissions.authentication.save('acct2', SITE, httpAuth(), 'site', current);
    await permissions.clearAllForOrigin(SITE);
    expect(await permissions.authentication.isAllowed('acct1', SITE, httpAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct2', SITE, httpAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct1', OTHER, httpAuth())).toBe(true);
  });

  test('deleting an account revokes its grants, including a shared relay one', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, relayAuth(), 'connected-sites', current);
    await permissions.authentication.save('acct2', SITE, relayAuth(), 'connected-sites', current);
    await permissions.clearForAccount('acct1');
    expect(await permissions.authentication.isAllowed('acct1', OTHER, relayAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct2', OTHER, relayAuth())).toBe(true);
  });

  test('clearing a site in global mode revokes every account\'s grants for it, not none', async () => {
    // In global mode an empty accountId is legal and means the shared bucket. Grants have no
    // shared bucket, so the conservative reading is every account's grants for this origin --
    // and an empty string is never handed to a filter that would treat it as a wildcard.
    const store = new MemoryStore({ signerUseGlobalDefaults: true });
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, httpAuth(), 'site', current);
    await permissions.authentication.save('acct2', SITE, httpAuth(), 'site', current);
    await permissions.authentication.save('acct1', OTHER, httpAuth(), 'site', current);
    await permissions.clear(SITE, '');
    expect(await permissions.authentication.isAllowed('acct1', SITE, httpAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct2', SITE, httpAuth())).toBe(false);
    expect(await permissions.authentication.isAllowed('acct1', OTHER, httpAuth())).toBe(true);
  });

  test('a clear with nowhere to write revokes nothing before it refuses', async () => {
    // Per-account mode, empty accountId: the refusal has to come before the revocation, or a
    // call that fails has already taken the user's credentials away.
    const store = new MemoryStore({ signerUseGlobalDefaults: false });
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, httpAuth(), 'site', current);
    await expect(permissions.clear(SITE, '')).rejects.toThrow(/accountId/);
    expect(await permissions.authentication.isAllowed('acct1', SITE, httpAuth())).toBe(true);
  });

  test('the refusal to wipe the shared bucket applies to grants too', async () => {
    // `clearForAccount('_default')` is refused on purpose: the shared bucket is not one
    // account's overrides, and deleting an account must not wipe every account's rules. The
    // grant revocation sits BEHIND that guard rather than in front of it, so the refusal means
    // the same thing for a credential as it does for a rule. A grant keyed by `_default` is a
    // caller bug (grants are always keyed by a real account id) and is left alone rather than
    // being the one thing a refused call still deletes.
    const store = new MemoryStore({
      authenticationGrants: [
        { id: 'shared-bucket', accountId: '_default', origin: SITE, protocol: 'nip98', destination: 'https://api.test', method: 'POST' },
      ],
    });
    const permissions = new Permissions(store);
    await permissions.authentication.save('acct1', SITE, httpAuth(), 'site', current);
    await permissions.clearForAccount('_default');
    expect(await permissions.authentication.list()).toHaveLength(2);
  });
});
