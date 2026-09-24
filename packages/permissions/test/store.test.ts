/**
 * The stored half: buckets, modes, migrations, concurrency and the cache.
 *
 * Two things are being protected here. One is that a browser extension's existing
 * `signerPermissions` blob keeps meaning what it meant, which is why the storage keys are
 * written out as literals rather than imported in the compatibility tests. The other is
 * that concurrent writers do not clobber each other, which is the only reason the lock
 * exists and so is tested by racing two saves directly.
 */
import { describe, test, expect, vi } from 'vitest';
import { MemoryStore, type KeyValueStore } from '@nostr-wot/storage';
import {
  Permissions,
  PERMISSIONS_STORAGE_KEY,
  GLOBAL_DEFAULTS_KEY,
  DEFAULT_BUCKET,
  DM_SIGN_KINDS,
  permissionKey,
  siteScopes,
  type PermissionMap,
} from '../src/index.js';

/** The stored tree, read straight out of the store rather than through the class. */
async function raw(store: KeyValueStore): Promise<PermissionMap> {
  return (await store.get<PermissionMap>(PERMISSIONS_STORAGE_KEY)) ?? {};
}

/**
 * A store holding a pre-migration tree.
 *
 * Seeded through the store rather than through `saveDirect`, which now refuses the raw
 * DM-kind keys precisely because nothing consults them.
 */
function seeded(tree: PermissionMap, flags: Record<string, unknown> = {}): MemoryStore {
  return new MemoryStore({ [PERMISSIONS_STORAGE_KEY]: tree, ...flags });
}

/** A store that cannot report changes, so only explicit invalidation can save it. */
function withoutSubscribe(store: KeyValueStore): KeyValueStore {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    remove: (key) => store.remove(key),
    keys: () => store.keys(),
  };
}

describe('storage compatibility with the browser extension', () => {
  test('the storage keys are the ones the extension already wrote', () => {
    expect(PERMISSIONS_STORAGE_KEY).toBe('signerPermissions');
    expect(GLOBAL_DEFAULTS_KEY).toBe('signerUseGlobalDefaults');
    expect(DEFAULT_BUCKET).toBe('_default');
  });

  test('an existing extension blob is read without migration', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'example.com': {
          _default: { 'signEvent:1': 'allow', sendMessages: 'deny' },
          acct_abc123: { 'signEvent:1': 'deny' },
        },
      },
    });
    const permissions = new Permissions(store);

    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('allow');
    expect(await permissions.check('example.com', 'nip44Encrypt', undefined, 'acct')).toBe('deny');
    expect(await permissions.check('example.com', 'signEvent', 2, 'acct')).toBe('ask');
    expect(await permissions.check('other.com', 'signEvent', 1, 'acct')).toBe('ask');
  });

  test('a save writes the shape the extension expects', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct');

    expect(await raw(store)).toEqual({
      'example.com': { _default: { 'signEvent:1': 'allow' } },
    });
  });
});

describe('mode-based resolution', () => {
  test('global defaults are on when nothing is stored', async () => {
    const permissions = new Permissions(new MemoryStore());
    expect(await permissions.getUseGlobalDefaults()).toBe(true);
  });

  test('global mode consults only the _default bucket', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'example.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'deny' } },
      },
    });
    const permissions = new Permissions(store);

    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('allow');
  });

  test('per-account mode consults only the account bucket', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'example.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'deny' } },
      },
      signerUseGlobalDefaults: false,
    });
    const permissions = new Permissions(store);

    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('deny');
    // An account with no bucket of its own falls back to asking, not to _default.
    expect(await permissions.check('example.com', 'signEvent', 1, 'other')).toBe('ask');
  });

  test('a mode switch preserves the dormant bucket', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.setUseGlobalDefaults(false);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct');

    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('deny');

    await permissions.setUseGlobalDefaults(true);
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('allow');
    expect(await raw(store)).toEqual({
      'example.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'deny' } },
    });
  });

  test('in global mode a write lands in _default even with an account id', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct');
    expect(await raw(store)).toEqual({ 'example.com': { _default: { 'signEvent:1': 'allow' } } });
  });
});

describe('save, saveDirect and getAll', () => {
  test('approving a DM kind covers the whole send flow but no other kind', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('chat.com', 'signEvent', 4, 'allow', 'acct');

    expect(await permissions.check('chat.com', 'signEvent', 4, 'acct')).toBe('allow');
    expect(await permissions.check('chat.com', 'signEvent', 1059, 'acct')).toBe('allow');
    expect(await permissions.check('chat.com', 'nip04Encrypt', undefined, 'acct')).toBe('allow');
    expect(await permissions.check('chat.com', 'nip44Encrypt', undefined, 'acct')).toBe('allow');
    expect(await permissions.check('chat.com', 'signEvent', 1, 'acct')).toBe('ask');
  });

  test('saveDirect writes a key verbatim', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.saveDirect('chat.com', 'signEvent:1111', 'allow', 'acct');

    expect(await raw(store)).toEqual({ 'chat.com': { _default: { 'signEvent:1111': 'allow' } } });
  });

  test('getAll and getForOrigin report the active bucket', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.save('b.com', 'getPublicKey', null, 'deny', 'acct');

    expect(await permissions.getAll('acct')).toEqual({
      'a.com': { 'signEvent:1': 'allow' },
      'b.com': { getPublicKey: 'deny' },
    });
    expect(await permissions.getForOrigin('a.com', 'acct')).toEqual({ 'signEvent:1': 'allow' });
    expect(await permissions.getForOrigin('nowhere.com', 'acct')).toEqual({});
  });

  test('an origin is any caller label, not only a hostname', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('com.example.android', 'signEvent', 1, 'allow', 'acct');
    await permissions.save('npub1deadbeef', 'signEvent', 1, 'deny', 'acct');

    expect(await permissions.check('com.example.android', 'signEvent', 1, 'acct')).toBe('allow');
    expect(await permissions.check('npub1deadbeef', 'signEvent', 1, 'acct')).toBe('deny');
  });

  test('a stored hostname rule still covers the matching https origin', async () => {
    expect(siteScopes('https://example.com')).toEqual(['https://example.com', 'example.com']);
    expect(siteScopes('com.example.android')).toEqual(['com.example.android']);

    const store = new MemoryStore({
      signerPermissions: { 'example.com': { _default: { 'signEvent:1': 'allow' } } },
    });
    const permissions = new Permissions(store);
    expect(await permissions.check('https://example.com', 'signEvent', 1, 'acct')).toBe('allow');

    // An exact-origin rule overrides the legacy hostname rule for the same key.
    await permissions.save('https://example.com', 'signEvent', 1, 'deny', 'acct');
    expect(await permissions.check('https://example.com', 'signEvent', 1, 'acct')).toBe('deny');
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('allow');
  });
});

describe('clearing', () => {
  test('clear with no origin removes everything', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.clear(undefined, 'acct');

    expect(await store.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
  });

  test('clear touches only the active mode bucket', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'allow' } },
      },
    });
    const permissions = new Permissions(store);
    await permissions.clear('a.com', 'acct');

    expect(await raw(store)).toEqual({ 'a.com': { acct: { 'signEvent:1': 'allow' } } });
  });

  test('clearAllForOrigin is a full revocation across every bucket and scope', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'https://a.com': { _default: { 'signEvent:1': 'allow' } },
        'a.com': { acct: { 'signEvent:1': 'allow' } },
        'b.com': { _default: { 'signEvent:1': 'allow' } },
      },
    });
    const permissions = new Permissions(store);
    await permissions.clearAllForOrigin('https://a.com');

    expect(await raw(store)).toEqual({ 'b.com': { _default: { 'signEvent:1': 'allow' } } });
  });

  test('clearForAccount removes one account everywhere and never touches _default', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'deny' } },
        'b.com': { acct: { 'signEvent:1': 'deny' } },
      },
    });
    const permissions = new Permissions(store);

    await permissions.clearForAccount(DEFAULT_BUCKET);
    expect(Object.keys(await raw(store))).toEqual(['a.com', 'b.com']);

    await permissions.clearForAccount('acct');
    expect(await raw(store)).toEqual({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
  });
});

describe('copyPermissions and setupNewAccountPermissions', () => {
  test('copyPermissions deep copies one bucket into another', async () => {
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { 'signEvent:1': 'allow' } } },
    });
    const permissions = new Permissions(store);
    await permissions.copyPermissions(null, 'acct');

    const tree = await raw(store);
    expect(tree['a.com']?.acct).toEqual({ 'signEvent:1': 'allow' });

    // A copy, not a reference: editing the source later must not move the copy.
    await permissions.saveDirect('a.com', 'signEvent:1', 'deny', 'acct');
    expect((await raw(store))['a.com']?.acct).toEqual({ 'signEvent:1': 'allow' });
  });

  test('an empty source id is a caller bug, not a request for the default bucket', async () => {
    const store = seeded({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    const permissions = new Permissions(store);
    await permissions.setUseGlobalDefaults(false);

    // '' type-checks against `string | null` but is not the documented default signal.
    // Without the guard it copies the dormant global bucket into the new account.
    await expect(permissions.copyPermissions('', 'newacct')).rejects.toThrow(/source account id/);

    expect(await permissions.check('a.com', 'signEvent', 1, 'newacct')).toBe('ask');
    expect(await raw(store)).toEqual({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
  });

  test('null still means the default bucket', async () => {
    const store = seeded({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    const permissions = new Permissions(store);
    await permissions.copyPermissions(null, 'newacct');

    expect((await raw(store))['a.com']?.newacct).toEqual({ 'signEvent:1': 'allow' });
  });

  test('a fresh account is isolated while the existing account keeps what it had', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    // Global mode: this grant lives in the shared _default bucket.
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.setupNewAccountPermissions('new', ['old'], null);

    expect(await permissions.getUseGlobalDefaults()).toBe(false);
    // The ordering is the whole point: copy first, switch mode second.
    expect(await permissions.check('a.com', 'signEvent', 1, 'old')).toBe('allow');
    expect(await permissions.check('a.com', 'signEvent', 1, 'new')).toBe('ask');
  });

  test('copying from an existing account gives the new one the same answers', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.save('a.com', 'getPublicKey', null, 'deny', 'acct');
    await permissions.setupNewAccountPermissions('new', ['old'], 'old');

    expect(await permissions.check('a.com', 'signEvent', 1, 'new')).toBe('allow');
    expect(await permissions.check('a.com', 'getPublicKey', undefined, 'new')).toBe('deny');
    expect(await permissions.check('a.com', 'signEvent', 1, 'old')).toBe('allow');
  });

  test('in per-account mode the mode is left alone and nothing is back-filled', async () => {
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { 'signEvent:1': 'allow' } } },
      signerUseGlobalDefaults: false,
    });
    const permissions = new Permissions(store);
    await permissions.setupNewAccountPermissions('new', ['old'], null);

    expect(await permissions.getUseGlobalDefaults()).toBe(false);
    expect(await permissions.check('a.com', 'signEvent', 1, 'old')).toBe('ask');
    expect(await permissions.check('a.com', 'signEvent', 1, 'new')).toBe('ask');
  });
});

describe('migrations', () => {
  test('migrateToPerKind drops the old blanket keys and keeps the logical groups', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': {
          _default: {
            signEvent: 'allow',
            nip04Encrypt: 'allow',
            nip44Decrypt: 'deny',
            '*': 'allow',
            'signEvent:1': 'allow',
            sendMessages: 'allow',
            readMessages: 'deny',
          },
        },
      },
    });
    const permissions = new Permissions(store);
    await permissions.migrateToPerKind();

    expect(await permissions.getForOrigin('a.com', 'acct')).toEqual({
      'signEvent:1': 'allow',
      sendMessages: 'allow',
      readMessages: 'deny',
      // A blanket deny is kept: the cascade still consults the bare method key, and a user
      // who said no must not find the method allowed after an upgrade.
      nip44Decrypt: 'deny',
    });
  });

  /**
   * A blanket `deny` is not a grant the per-kind model cannot express; it is a refusal the
   * cascade still honours at the method and wildcard levels, and it is exactly what a
   * remembered "deny, every kind" writes. `migrate()` re-runs every migration whenever the
   * stored version differs, so a migration that deleted it would wipe every remembered
   * refusal on the next version bump.
   */
  test('migrateToPerKind keeps a blanket deny, in both the bucketed and the flat shape', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': { _default: { signEvent: 'deny', '*': 'allow', 'signEvent:1': 'allow' }, acct: { '*': 'deny' } },
        'flat.com': { signEvent: 'deny', nip04Encrypt: 'allow' },
      },
    });
    const permissions = new Permissions(store);
    await permissions.migrate();

    expect(await raw(store)).toEqual({
      'a.com': { _default: { signEvent: 'deny', 'signEvent:1': 'allow' }, acct: { '*': 'deny' } },
      'flat.com': { _default: { signEvent: 'deny' } },
    });
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('deny');
    await permissions.setUseGlobalDefaults(false);
    expect(await permissions.check('a.com', 'getPublicKey', undefined, 'acct')).toBe('deny');
    // And it survives the next bump too: running everything again changes nothing.
    await store.set('_permMigrationVersion', 0);
    await permissions.migrate();
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('deny');
  });

  test('migrateToPerKind empties an origin that held nothing but blanket keys', async () => {
    const store = new MemoryStore({ signerPermissions: { 'a.com': { _default: { '*': 'allow' } } } });
    const permissions = new Permissions(store);
    await permissions.migrateToPerKind();

    expect(await raw(store)).toEqual({});
  });

  test('migrateToPerAccount wraps a flat origin under _default', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'flat.com': { 'signEvent:1': 'allow' },
        'done.com': { _default: { 'signEvent:1': 'deny' } },
      },
    });
    const permissions = new Permissions(store);
    await permissions.migrateToPerAccount();

    expect(await raw(store)).toEqual({
      'flat.com': { _default: { 'signEvent:1': 'allow' } },
      'done.com': { _default: { 'signEvent:1': 'deny' } },
    });

    // Idempotent: running it again changes nothing.
    await permissions.migrateToPerAccount();
    expect((await raw(store))['flat.com']).toEqual({ _default: { 'signEvent:1': 'allow' } });
  });

  test('migrateForwardToAsk rewrites the retired forward value', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': { _default: { 'signEvent:1': 'forward', 'signEvent:0': 'allow' } },
      },
    });
    const permissions = new Permissions(store);
    await permissions.migrateForwardToAsk();

    expect(await permissions.getForOrigin('a.com', 'acct')).toEqual({
      'signEvent:1': 'ask',
      'signEvent:0': 'allow',
    });
  });

  describe('migrateDmKindsToSendMessages', () => {
    test('moves a stored signEvent:4 entry into sendMessages', async () => {
      const permissions = new Permissions(seeded({ 'chat.com': { _default: { 'signEvent:4': 'allow' } } }));
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'allow' });
    });

    test('merges several DM kinds most-restrictive-wins', async () => {
      const permissions = new Permissions(
        seeded({
          'chat.com': {
            _default: { 'signEvent:4': 'allow', 'signEvent:13': 'deny', 'signEvent:1059': 'allow' },
          },
        }),
      );
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'deny' });
    });

    test('the ranking is deny over ask over allow', async () => {
      const permissions = new Permissions(
        seeded({ 'chat.com': { _default: { 'signEvent:4': 'allow', 'signEvent:14': 'ask' } } }),
      );
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'ask' });
    });

    test('an existing sendMessages deny survives a less restrictive DM kind', async () => {
      const permissions = new Permissions(
        seeded({ 'chat.com': { _default: { sendMessages: 'deny', 'signEvent:4': 'allow' } } }),
      );
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'deny' });
    });

    test('a more restrictive DM kind escalates an existing sendMessages allow', async () => {
      const permissions = new Permissions(
        seeded({ 'chat.com': { _default: { sendMessages: 'allow', 'signEvent:13': 'deny' } } }),
      );
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'deny' });
    });

    test('non-DM kinds are untouched and an origin without DM kinds is a no-op', async () => {
      const store = new MemoryStore();
      const permissions = new Permissions(store);
      await permissions.saveDirect('chat.com', 'signEvent:1', 'allow', 'acct');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ 'signEvent:1': 'allow' });
    });

    test('every DM kind is migrated in every bucket', async () => {
      const store = new MemoryStore({
        signerPermissions: {
          'chat.com': {
            _default: { 'signEvent:4': 'allow' },
            acct: { 'signEvent:14': 'deny', 'signEvent:1059': 'allow' },
          },
        },
      });
      const permissions = new Permissions(store);
      await permissions.migrateDmKindsToSendMessages();

      expect(await raw(store)).toEqual({
        'chat.com': { _default: { sendMessages: 'allow' }, acct: { sendMessages: 'deny' } },
      });
    });
  });

  test('migrate runs all four in order, once', async () => {
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { 'signEvent:4': 'forward', '*': 'allow' } },
    });
    const permissions = new Permissions(store);
    await permissions.migrate();

    // Flat -> bucketed, blanket '*' dropped, 'forward' -> 'ask', DM kind -> sendMessages.
    expect(await raw(store)).toEqual({ 'a.com': { _default: { sendMessages: 'ask' } } });
    expect(await store.get('_permMigrationVersion')).toBe(4);

    // A second run must not touch already-migrated data. Written through the store,
    // because saveDirect refuses the raw DM-kind key.
    await store.set(PERMISSIONS_STORAGE_KEY, { 'a.com': { _default: { 'signEvent:4': 'allow' } } });
    await permissions.migrate();
    expect((await raw(store))['a.com']?._default?.['signEvent:4']).toBe('allow');
  });
});

describe('concurrency and the cache', () => {
  test('two overlapping saves to the same origin do not clobber each other', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await Promise.all([
      permissions.save('a.com', 'signEvent', 1, 'allow', 'acct'),
      permissions.save('a.com', 'signEvent', 2, 'deny', 'acct'),
      permissions.saveDirect('a.com', 'getPublicKey', 'allow', 'acct'),
    ]);

    expect(await raw(store)).toEqual({
      'a.com': { _default: { 'signEvent:1': 'allow', 'signEvent:2': 'deny', getPublicKey: 'allow' } },
    });
  });

  test('overlapping saves across origins all survive', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        permissions.save(`site${index}.com`, 'signEvent', 1, 'allow', 'acct'),
      ),
    );

    expect(Object.keys(await raw(store))).toHaveLength(12);
  });

  test('a write invalidates the cache even when the store cannot report changes', async () => {
    const backing = new MemoryStore();
    const permissions = new Permissions(withoutSubscribe(backing));

    // Populate the cache, then write, then read again.
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');

    expect(await permissions.getUseGlobalDefaults()).toBe(true);
    await permissions.setUseGlobalDefaults(false);
    expect(await permissions.getUseGlobalDefaults()).toBe(false);
  });

  test('a change made outside this instance invalidates the cache through subscribe', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');

    // Another context (another tab, another process) writes the same key.
    await store.set(PERMISSIONS_STORAGE_KEY, { 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');

    await store.set(GLOBAL_DEFAULTS_KEY, false);
    expect(await permissions.getUseGlobalDefaults()).toBe(false);
  });

  test('dispose stops listening', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');

    permissions.dispose();
    await store.set(PERMISSIONS_STORAGE_KEY, { 'a.com': { _default: { 'signEvent:1': 'allow' } } });

    // Stale, because nothing invalidated the cache: the point is that dispose worked.
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    permissions.invalidateCache();
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
  });

  test('a store with no subscribe is usable', async () => {
    const permissions = new Permissions(withoutSubscribe(new MemoryStore()));
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
    expect(() => permissions.dispose()).not.toThrow();
  });
});

describe('a revocation is not reversible by a concurrent write', () => {
  /** A store whose writes land later than its removals, as every real backend's do. */
  function slowWrites(store: KeyValueStore, delayMs: number): KeyValueStore {
    const view: KeyValueStore = {
      get: (key) => store.get(key),
      set: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return store.set(key, value);
      },
      remove: (key) => store.remove(key),
      keys: () => store.keys(),
    };
    const underlying = store.subscribe;
    if (underlying) view.subscribe = (listener) => underlying.call(store, listener);
    return view;
  }

  test('clear() with no origin cannot be overtaken by a save already in flight', async () => {
    const backing = new MemoryStore();
    const permissions = new Permissions(slowWrites(backing, 20));

    await permissions.saveDirect('evil.com', 'signEvent:1', 'allow', 'acct');

    // The save loads the tree first and writes it back last. Unlocked, its write lands
    // after the removal and resurrects every grant the user had just revoked.
    await Promise.all([permissions.saveDirect('good.com', 'signEvent:1', 'allow', 'acct'), permissions.clear(undefined, 'acct')]);

    expect(await backing.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
    expect(await permissions.check('evil.com', 'signEvent', 1, 'acct')).toBe('ask');
    expect(await permissions.check('good.com', 'signEvent', 1, 'acct')).toBe('ask');
  });
});

describe('a failed write never leaves the cache more permissive than the disk', () => {
  /** A store whose `set` rejects once armed. */
  function brittle(store: KeyValueStore): { store: KeyValueStore; arm: (on: boolean) => void } {
    let failing = false;
    const view: KeyValueStore = {
      get: (key) => store.get(key),
      set: async (key, value) => {
        if (failing) throw new Error('quota exceeded');
        return store.set(key, value);
      },
      remove: (key) => store.remove(key),
      keys: () => store.keys(),
    };
    const underlying = store.subscribe;
    if (underlying) view.subscribe = (listener) => underlying.call(store, listener);
    return { store: view, arm: (on: boolean) => (failing = on) };
  }

  test('an allow that failed to persist is not answered from the cache', async () => {
    const backing = new MemoryStore();
    const { store, arm } = brittle(backing);
    const permissions = new Permissions(store);

    arm(true);
    await expect(permissions.save('a.com', 'signEvent', 1, 'allow', 'acct')).rejects.toThrow('quota exceeded');

    expect(await backing.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');

    // And the instance still works once the store recovers.
    arm(false);
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
  });

  test('a deny that failed to persist is not answered from the cache either', async () => {
    const backing = new MemoryStore();
    const { store, arm } = brittle(backing);
    const permissions = new Permissions(store);

    arm(true);
    await expect(permissions.save('a.com', 'signEvent', 1, 'deny', 'acct')).rejects.toThrow('quota exceeded');

    expect(await backing.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
  });

  /**
   * Reads are deliberately not serialized against writes, so a `check` can land at any
   * point during a save. It must never see a decision that has not reached the store yet:
   * the whole window between "mutated in memory" and "written to disk" is time in which an
   * authorization cache would be answering more permissively than the disk behind it.
   */
  test('a check during an in-flight save does not observe the decision early', async () => {
    const backing = new MemoryStore();
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const parked = new Promise<void>((resolve) => (releaseWrite = resolve));
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    let gated = false;

    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (gated) {
          gated = false;
          writeStarted();
          await parked;
        }
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
      subscribe: (listener) => backing.subscribe(listener),
    };
    const permissions = new Permissions(store);

    gated = true;
    const saving = permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await started; // the store write is now genuinely in flight

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    expect(await permissions.getForOrigin('a.com', 'acct')).toEqual({});

    releaseWrite();
    await saving;

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
  });

  test('a check during an in-flight save that then FAILS never saw the decision at all', async () => {
    const backing = new MemoryStore();
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const parked = new Promise<void>((resolve) => (releaseWrite = resolve));
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    let gated = false;

    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (gated) {
          gated = false;
          writeStarted();
          await parked;
          throw new Error('quota exceeded');
        }
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
      subscribe: (listener) => backing.subscribe(listener),
    };
    const permissions = new Permissions(store);

    gated = true;
    const saving = permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await started;

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    releaseWrite();
    await expect(saving).rejects.toThrow('quota exceeded');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
  });

  test('a failed write does not strand a stored grant behind a phantom', async () => {
    const backing = seeded({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    const { store, arm } = brittle(backing);
    const permissions = new Permissions(store);

    arm(true);
    await expect(permissions.save('a.com', 'signEvent', 1, 'deny', 'acct')).rejects.toThrow('quota exceeded');

    // What is on disk is still the allow, and that is what the cache must report.
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
  });
});

describe('per-account mode fails closed without an accountId', () => {
  test('a missing or empty accountId resolves to ask, never to _default', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');
    await permissions.setUseGlobalDefaults(false);

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    expect(await permissions.check('a.com', 'signEvent', 1, '')).toBe('ask');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('ask');
    expect(await permissions.getForOrigin('a.com', 'acct')).toEqual({});
    expect(await permissions.getAll('acct')).toEqual({});

    // The _default bucket is still there, just out of reach until the mode says otherwise.
    expect(await raw(store)).toEqual({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
  });

  test('a write with nowhere to go is refused rather than landing in _default', async () => {
    // Omitting the id is a compile error now (see contracts.test-d.ts); the empty string is
    // the runtime half, for a caller that built an id from a variable and got nothing.
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.setUseGlobalDefaults(false);

    await expect(permissions.save('a.com', 'signEvent', 1, 'allow', '')).rejects.toThrow(/accountId/);
    await expect(permissions.saveDirect('a.com', 'getPublicKey', 'allow', '')).rejects.toThrow(/accountId/);
    await expect(permissions.clear('a.com', '')).rejects.toThrow(/accountId/);
    expect(await raw(store)).toEqual({});
  });

  test('global mode keeps the fallback, where _default is the right bucket by definition', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
    expect(await permissions.check('a.com', 'signEvent', 1, '')).toBe('allow');
    expect(await permissions.check('a.com', 'signEvent', 1, 'anyone')).toBe('allow');
    expect(await permissions.getAll('acct')).toEqual({ 'a.com': { 'signEvent:1': 'allow' } });
  });
});

describe('the one place an allow beats a deny', () => {
  test('an exact-origin allow overrides the same key denied on the legacy hostname', async () => {
    const store = seeded({ 'example.com': { _default: { 'signEvent:1': 'deny' } } });
    const permissions = new Permissions(store);

    expect(await permissions.check('https://example.com', 'signEvent', 1, 'acct')).toBe('deny');

    // Deliberate, and the only exception to deny-wins in the system: an exact-origin rule
    // is a later and more specific statement about the same key than the legacy hostname
    // rule it replaces, so it replaces it before the cascade ever runs.
    await permissions.save('https://example.com', 'signEvent', 1, 'allow', 'acct');
    expect(await permissions.check('https://example.com', 'signEvent', 1, 'acct')).toBe('allow');

    // The legacy rule itself is untouched, and still governs the bare hostname.
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct')).toBe('deny');
  });

  test('a legacy deny on a DIFFERENT key still wins, because the cascade still runs', async () => {
    const store = seeded({ 'example.com': { _default: { '*': 'deny' } } });
    const permissions = new Permissions(store);

    await permissions.save('https://example.com', 'signEvent', 1, 'allow', 'acct');

    // The exact origin overrode nothing: the wildcard deny is a different key, survives
    // the merge, and denies.
    expect(await permissions.check('https://example.com', 'signEvent', 1, 'acct')).toBe('deny');
  });
});

describe('a dead permission key is refused, not silently stored', () => {
  test('saveDirect rejects the DM-kind keys that nothing ever consults', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    // Driven off DM_SIGN_KINDS rather than a hand list, so the guard and the constant
    // cannot drift apart without this failing.
    expect(DM_SIGN_KINDS.size).toBeGreaterThan(0);
    for (const kind of DM_SIGN_KINDS) {
      await expect(permissions.saveDirect('chat.com', `signEvent:${kind}`, 'deny', 'acct')).rejects.toThrow(
        /sendMessages/,
      );
    }
    expect(await raw(store)).toEqual({});
  });

  test('every kind the guard rejects is one permissionKey would have collapsed', () => {
    for (const kind of DM_SIGN_KINDS) {
      expect(permissionKey('signEvent', kind)).toBe('sendMessages');
    }
  });

  test('save still accepts the same kinds, because it maps them first', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('chat.com', 'signEvent', 4, 'deny', 'acct');

    expect(await permissions.getForOrigin('chat.com', 'acct')).toEqual({ sendMessages: 'deny' });
    expect(await permissions.check('chat.com', 'signEvent', 4, 'acct')).toBe('deny');
  });

  test('non-DM signEvent keys are still accepted verbatim', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.saveDirect('a.com', 'signEvent:1', 'allow', 'acct');
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('allow');
  });
});

/**
 * The empty string type-checks wherever a label is expected and means nothing, so every
 * mutating path treats it as a caller bug. The audit behind this block walked all of the
 * class's public methods; the three that were found silently no-opping, the one that
 * silently wiped everything and the one that silently stored junk are all pinned here.
 */
describe('an empty label is refused by every mutating path', () => {
  test('clear("") does not mean "wipe every permission there is"', async () => {
    const store = seeded({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    const permissions = new Permissions(store);

    await expect(permissions.clear('', 'acct')).rejects.toThrow(/origin must not be empty/);
    expect(await raw(store)).toEqual({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });

    // Omitting it entirely still means everything, as ruled.
    await permissions.clear(undefined, 'acct');
    expect(await store.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
  });

  test('clearAllForOrigin("") throws instead of doing nothing', async () => {
    const permissions = new Permissions(new MemoryStore());
    await expect(permissions.clearAllForOrigin('')).rejects.toThrow(/origin must not be empty/);
  });

  test('clearForAccount("") throws, while _default is still refused quietly', async () => {
    const store = seeded({
      'a.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'deny' } },
    });
    const permissions = new Permissions(store);

    await expect(permissions.clearForAccount('')).rejects.toThrow(/account id must not be empty/);

    // Refusing the shared bucket is a deliberate safety rule, not a swallowed caller bug.
    await expect(permissions.clearForAccount(DEFAULT_BUCKET)).resolves.toBeUndefined();
    expect((await raw(store))['a.com']?._default).toEqual({ 'signEvent:1': 'allow' });
  });

  test('copyPermissions("acct", "") throws instead of copying nothing', async () => {
    const store = seeded({ 'a.com': { acct: { 'signEvent:1': 'allow' } } });
    const permissions = new Permissions(store);

    await expect(permissions.copyPermissions('acct', '')).rejects.toThrow(
      /target account id must not be empty/,
    );
    expect(await raw(store)).toEqual({ 'a.com': { acct: { 'signEvent:1': 'allow' } } });
  });

  test('setupNewAccountPermissions("") throws instead of silently skipping the wizard', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('a.com', 'signEvent', 1, 'allow', 'acct');

    await expect(permissions.setupNewAccountPermissions('', ['old'], null)).rejects.toThrow(
      /new account id must not be empty/,
    );

    // And it failed before changing anything: still global mode, still one bucket.
    expect(await permissions.getUseGlobalDefaults()).toBe(true);
    expect(await raw(store)).toEqual({ 'a.com': { _default: { 'signEvent:1': 'allow' } } });
  });

  test('save and saveDirect refuse an empty origin or an empty key', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await expect(permissions.save('', 'signEvent', 1, 'allow', 'acct')).rejects.toThrow(
      /origin must not be empty/,
    );
    await expect(permissions.saveDirect('', 'getPublicKey', 'allow', 'acct')).rejects.toThrow(
      /origin must not be empty/,
    );
    await expect(permissions.saveDirect('a.com', '', 'allow', 'acct')).rejects.toThrow(
      /permission key must not be empty/,
    );
    expect(await raw(store)).toEqual({});
  });

  /**
   * Reads are deliberately NOT guarded. An authorization check that throws into a signing
   * path is worse than one that prompts, and an unknown origin already resolves to `ask`,
   * which is the safest answer there is.
   */
  test('reads stay tolerant of an empty origin and answer ask', async () => {
    const permissions = new Permissions(
      seeded({ 'a.com': { _default: { 'signEvent:1': 'allow' } } }),
    );

    expect(await permissions.check('', 'signEvent', 1, 'acct')).toBe('ask');
    expect(await permissions.getForOrigin('', 'acct')).toEqual({});
    expect(await permissions.getForOriginRaw('')).toEqual({});
  });
});

describe('the injected logger', () => {
  test('a denial is reported with the key that denied it, and nothing else is', async () => {
    const logger = { warn: vi.fn() };
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { 'signEvent:1': 'allow', '*': 'deny' } } },
    });
    const permissions = new Permissions(store, { logger });

    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('deny');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ origin: 'a.com', key: '*' });
  });

  test('no logger is required', async () => {
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { '*': 'deny' } } },
    });
    const permissions = new Permissions(store);
    expect(await permissions.check('a.com', 'signEvent', 1, 'acct')).toBe('deny');
  });
});
