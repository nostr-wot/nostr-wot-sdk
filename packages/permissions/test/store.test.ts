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
  siteScopes,
  type PermissionMap,
} from '../src/index.js';

/** The stored tree, read straight out of the store rather than through the class. */
async function raw(store: KeyValueStore): Promise<PermissionMap> {
  return (await store.get<PermissionMap>(PERMISSIONS_STORAGE_KEY)) ?? {};
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

    expect(await permissions.check('example.com', 'signEvent', 1)).toBe('allow');
    expect(await permissions.check('example.com', 'nip44Encrypt')).toBe('deny');
    expect(await permissions.check('example.com', 'signEvent', 2)).toBe('ask');
    expect(await permissions.check('other.com', 'signEvent', 1)).toBe('ask');
  });

  test('a save writes the shape the extension expects', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('example.com', 'signEvent', 1, 'allow');

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

    await permissions.save('example.com', 'signEvent', 1, 'allow');
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
    await permissions.save('chat.com', 'signEvent', 4, 'allow');

    expect(await permissions.check('chat.com', 'signEvent', 4)).toBe('allow');
    expect(await permissions.check('chat.com', 'signEvent', 1059)).toBe('allow');
    expect(await permissions.check('chat.com', 'nip04Encrypt')).toBe('allow');
    expect(await permissions.check('chat.com', 'nip44Encrypt')).toBe('allow');
    expect(await permissions.check('chat.com', 'signEvent', 1)).toBe('ask');
  });

  test('saveDirect writes a key verbatim', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.saveDirect('chat.com', 'signEvent:4', 'allow');

    expect(await raw(store)).toEqual({ 'chat.com': { _default: { 'signEvent:4': 'allow' } } });
  });

  test('getAll and getForOrigin report the active bucket', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    await permissions.save('b.com', 'getPublicKey', null, 'deny');

    expect(await permissions.getAll()).toEqual({
      'a.com': { 'signEvent:1': 'allow' },
      'b.com': { getPublicKey: 'deny' },
    });
    expect(await permissions.getForOrigin('a.com')).toEqual({ 'signEvent:1': 'allow' });
    expect(await permissions.getForOrigin('nowhere.com')).toEqual({});
  });

  test('an origin is any caller label, not only a hostname', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('com.example.android', 'signEvent', 1, 'allow');
    await permissions.save('npub1deadbeef', 'signEvent', 1, 'deny');

    expect(await permissions.check('com.example.android', 'signEvent', 1)).toBe('allow');
    expect(await permissions.check('npub1deadbeef', 'signEvent', 1)).toBe('deny');
  });

  test('a stored hostname rule still covers the matching https origin', async () => {
    expect(siteScopes('https://example.com')).toEqual(['https://example.com', 'example.com']);
    expect(siteScopes('com.example.android')).toEqual(['com.example.android']);

    const store = new MemoryStore({
      signerPermissions: { 'example.com': { _default: { 'signEvent:1': 'allow' } } },
    });
    const permissions = new Permissions(store);
    expect(await permissions.check('https://example.com', 'signEvent', 1)).toBe('allow');

    // An exact-origin rule overrides the legacy hostname rule for the same key.
    await permissions.save('https://example.com', 'signEvent', 1, 'deny');
    expect(await permissions.check('https://example.com', 'signEvent', 1)).toBe('deny');
    expect(await permissions.check('example.com', 'signEvent', 1)).toBe('allow');
  });
});

describe('clearing', () => {
  test('clear with no origin removes everything', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    await permissions.clear();

    expect(await store.get(PERMISSIONS_STORAGE_KEY)).toBeUndefined();
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('ask');
  });

  test('clear touches only the active mode bucket', async () => {
    const store = new MemoryStore({
      signerPermissions: {
        'a.com': { _default: { 'signEvent:1': 'allow' }, acct: { 'signEvent:1': 'allow' } },
      },
    });
    const permissions = new Permissions(store);
    await permissions.clear('a.com');

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
    await permissions.saveDirect('a.com', 'signEvent:1', 'deny');
    expect((await raw(store))['a.com']?.acct).toEqual({ 'signEvent:1': 'allow' });
  });

  test('a fresh account is isolated while the existing account keeps what it had', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    // Global mode: this grant lives in the shared _default bucket.
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    await permissions.setupNewAccountPermissions('new', ['old'], null);

    expect(await permissions.getUseGlobalDefaults()).toBe(false);
    // The ordering is the whole point: copy first, switch mode second.
    expect(await permissions.check('a.com', 'signEvent', 1, 'old')).toBe('allow');
    expect(await permissions.check('a.com', 'signEvent', 1, 'new')).toBe('ask');
  });

  test('copying from an existing account gives the new one the same answers', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    await permissions.save('a.com', 'getPublicKey', null, 'deny');
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

    expect(await permissions.getForOrigin('a.com')).toEqual({
      'signEvent:1': 'allow',
      sendMessages: 'allow',
      readMessages: 'deny',
    });
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

    expect(await permissions.getForOrigin('a.com')).toEqual({
      'signEvent:1': 'ask',
      'signEvent:0': 'allow',
    });
  });

  describe('migrateDmKindsToSendMessages', () => {
    test('moves a stored signEvent:4 entry into sendMessages', async () => {
      const permissions = new Permissions(new MemoryStore());
      await permissions.saveDirect('chat.com', 'signEvent:4', 'allow');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ sendMessages: 'allow' });
    });

    test('merges several DM kinds most-restrictive-wins', async () => {
      const permissions = new Permissions(new MemoryStore());
      await permissions.saveDirect('chat.com', 'signEvent:4', 'allow');
      await permissions.saveDirect('chat.com', 'signEvent:13', 'deny');
      await permissions.saveDirect('chat.com', 'signEvent:1059', 'allow');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ sendMessages: 'deny' });
    });

    test('the ranking is deny over ask over allow', async () => {
      const permissions = new Permissions(new MemoryStore());
      await permissions.saveDirect('chat.com', 'signEvent:4', 'allow');
      await permissions.saveDirect('chat.com', 'signEvent:14', 'ask');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ sendMessages: 'ask' });
    });

    test('an existing sendMessages deny survives a less restrictive DM kind', async () => {
      const permissions = new Permissions(new MemoryStore());
      await permissions.saveDirect('chat.com', 'sendMessages', 'deny');
      await permissions.saveDirect('chat.com', 'signEvent:4', 'allow');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ sendMessages: 'deny' });
    });

    test('a more restrictive DM kind escalates an existing sendMessages allow', async () => {
      const permissions = new Permissions(new MemoryStore());
      await permissions.saveDirect('chat.com', 'sendMessages', 'allow');
      await permissions.saveDirect('chat.com', 'signEvent:13', 'deny');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ sendMessages: 'deny' });
    });

    test('non-DM kinds are untouched and an origin without DM kinds is a no-op', async () => {
      const store = new MemoryStore();
      const permissions = new Permissions(store);
      await permissions.saveDirect('chat.com', 'signEvent:1', 'allow');
      await permissions.migrateDmKindsToSendMessages();

      expect(await permissions.getForOrigin('chat.com')).toEqual({ 'signEvent:1': 'allow' });
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

    // A second run must not touch already-migrated data.
    await permissions.saveDirect('a.com', 'signEvent:4', 'allow');
    await permissions.migrate();
    expect((await raw(store))['a.com']?._default?.['signEvent:4']).toBe('allow');
  });
});

describe('concurrency and the cache', () => {
  test('two overlapping saves to the same origin do not clobber each other', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    await Promise.all([
      permissions.save('a.com', 'signEvent', 1, 'allow'),
      permissions.save('a.com', 'signEvent', 2, 'deny'),
      permissions.saveDirect('a.com', 'getPublicKey', 'allow'),
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
        permissions.save(`site${index}.com`, 'signEvent', 1, 'allow'),
      ),
    );

    expect(Object.keys(await raw(store))).toHaveLength(12);
  });

  test('a write invalidates the cache even when the store cannot report changes', async () => {
    const backing = new MemoryStore();
    const permissions = new Permissions(withoutSubscribe(backing));

    // Populate the cache, then write, then read again.
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('ask');
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('allow');

    expect(await permissions.getUseGlobalDefaults()).toBe(true);
    await permissions.setUseGlobalDefaults(false);
    expect(await permissions.getUseGlobalDefaults()).toBe(false);
  });

  test('a change made outside this instance invalidates the cache through subscribe', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);

    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('ask');

    // Another context (another tab, another process) writes the same key.
    await store.set(PERMISSIONS_STORAGE_KEY, { 'a.com': { _default: { 'signEvent:1': 'allow' } } });
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('allow');

    await store.set(GLOBAL_DEFAULTS_KEY, false);
    expect(await permissions.getUseGlobalDefaults()).toBe(false);
  });

  test('dispose stops listening', async () => {
    const store = new MemoryStore();
    const permissions = new Permissions(store);
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('ask');

    permissions.dispose();
    await store.set(PERMISSIONS_STORAGE_KEY, { 'a.com': { _default: { 'signEvent:1': 'allow' } } });

    // Stale, because nothing invalidated the cache: the point is that dispose worked.
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('ask');
    permissions.invalidateCache();
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('allow');
  });

  test('a store with no subscribe is usable', async () => {
    const permissions = new Permissions(withoutSubscribe(new MemoryStore()));
    await permissions.save('a.com', 'signEvent', 1, 'allow');
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('allow');
    expect(() => permissions.dispose()).not.toThrow();
  });
});

describe('the injected logger', () => {
  test('a denial is reported with the key that denied it, and nothing else is', async () => {
    const logger = { warn: vi.fn() };
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { 'signEvent:1': 'allow', '*': 'deny' } } },
    });
    const permissions = new Permissions(store, { logger });

    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('deny');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ origin: 'a.com', key: '*' });
  });

  test('no logger is required', async () => {
    const store = new MemoryStore({
      signerPermissions: { 'a.com': { _default: { '*': 'deny' } } },
    });
    const permissions = new Permissions(store);
    expect(await permissions.check('a.com', 'signEvent', 1)).toBe('deny');
  });
});
