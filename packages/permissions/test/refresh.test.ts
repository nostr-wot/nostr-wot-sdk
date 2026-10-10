import { describe, expect, test } from 'vitest';
import { MemoryStore, type KeyValueStore } from '@nostr-wot/storage';
import {
  Permissions, GLOBAL_RULES_SCOPE, DEFAULT_BUCKET, parseAuthentication, validAuthenticationScope,
  AuthenticationGrants, type AuthenticationRequest,
} from '../src/index.js';

const context = { accountIds: ['alice', 'bob'], origins: ['https://empty.example'] };
const request: AuthenticationRequest = {
  protocol: 'nip98', url: 'https://api.example/session', destination: 'https://api.example', method: 'POST', crossOrigin: true,
};

describe('global rule inheritance', () => {
  test('consolidates conservatively, preserves absent and conflicting site choices, then inherits explicitly', async () => {
    const store = new MemoryStore({ signerPermissions: {
      'https://allow.example': { _default: { getPublicKey: 'allow' }, alice: { getPublicKey: 'deny' } },
      'https://deny.example': { _default: { getPublicKey: 'deny' } },
    } });
    const permissions = new Permissions(store);
    await permissions.migrateToGlobalRules(context);
    expect(await permissions.check('https://allow.example', 'getPublicKey', undefined, 'alice')).toBe('allow');
    expect(await permissions.check('https://deny.example', 'getPublicKey', undefined, 'alice')).toBe('deny');
    expect(await permissions.check('https://empty.example', 'getPublicKey', undefined, 'alice')).toBe('ask');
    expect(await permissions.check('https://new.example', 'getPublicKey', undefined, 'alice')).toBe('deny');
    await permissions.inheritRule('https://allow.example', 'getPublicKey', 'alice');
    expect(await permissions.check('https://allow.example', 'getPublicKey', undefined, 'alice')).toBe('deny');
    await permissions.saveDirect(GLOBAL_RULES_SCOPE, 'getPublicKey', 'allow', DEFAULT_BUCKET);
    await permissions.saveDirect('https://new.example', 'getPublicKey', 'ask', 'alice');
    expect(await permissions.check('https://new.example', 'getPublicKey', undefined, 'alice')).toBe('ask');
    expect(await permissions.check('https://new.example', 'getPublicKey', undefined, 'bob')).toBe('allow');
    await expect(permissions.saveDirect('https://new.example', 'getPublicKey', 'allow', DEFAULT_BUCKET)).rejects.toThrow('Global rules');
    await expect(permissions.saveDirect(GLOBAL_RULES_SCOPE, 'getPublicKey', 'allow', 'alice')).rejects.toThrow('Global rules');
    expect(await permissions.check('https://new.example', 'getPublicKey', undefined, '')).toBe('ask');
  });

  test('per-account migration does not revive dormant shared allows', async () => {
    const store = new MemoryStore({ signerUseGlobalDefaults: false, signerPermissions: {
      'https://site.example': { _default: { getPublicKey: 'allow' }, alice: { sendMessages: 'deny' } },
    } });
    const permissions = new Permissions(store);
    await permissions.migrateToGlobalRules(context);
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'bob')).toBe('ask');
    expect(await permissions.check('https://site.example', 'nip44Encrypt', undefined, 'alice')).toBe('deny');
    const first = await permissions.getAllRaw();
    await permissions.migrateToGlobalRules(context);
    expect(await permissions.getAllRaw()).toEqual(first);
    await permissions.setUseGlobalDefaults(true);
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'bob')).toBe('ask');
  });

  test('new accounts inherit consolidated globals or copy site overrides without reviving stale rules', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.migrateToGlobalRules(context);
    await permissions.saveDirect(GLOBAL_RULES_SCOPE, 'getPublicKey', 'allow', DEFAULT_BUCKET);
    await permissions.saveDirect('https://site.example', 'getPublicKey', 'deny', 'alice');
    await permissions.saveDirect('https://other.example', 'getPublicKey', 'deny', 'new-account');
    await permissions.setupNewAccountPermissions('new-account', ['alice'], 'alice');
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'new-account')).toBe('deny');
    expect(await permissions.check('https://other.example', 'getPublicKey', undefined, 'new-account')).toBe('allow');
    await permissions.setupNewAccountPermissions('new-account', ['alice'], null);
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'new-account')).toBe('allow');
  });

  test('inheritance-only fresh accounts mask shared site rules until consolidation', async () => {
    const permissions = new Permissions(new MemoryStore({ signerPermissions: {
      'https://site.example': { _default: { getPublicKey: 'allow' } },
    } }));
    await permissions.migrateToInheritance(context);
    await permissions.setupNewAccountPermissions('new-account', ['alice'], null);
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'new-account')).toBe('ask');
  });

  test('reads current extension flags and preserves deny cascade across different keys', async () => {
    const permissions = new Permissions(new MemoryStore({ signerRulesInheritance: true, signerGlobalRulesVersion: 1, signerPermissions: {
      _global: { _default: { '*': 'deny', getPublicKey: 'allow' } },
      'site.example': { alice: { getPublicKey: 'allow' } },
    } }));
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'alice')).toBe('deny');
    expect(await permissions.getAll('alice')).not.toHaveProperty('_global');
  });

  test('failed multi-key migration fails closed and can resume in a fresh instance', async () => {
    const memory = new MemoryStore({ signerPermissions: { 'https://site.example': { _default: { getPublicKey: 'allow' } } } });
    let fail = true;
    const store: KeyValueStore = {
      get: key => memory.get(key), remove: key => memory.remove(key), keys: () => memory.keys(),
      set: async (key, value) => {
        if (key === 'signerRulesInheritance' && fail) throw new Error('disk full');
        await memory.set(key, value);
      },
    };
    const permissions = new Permissions(store);
    await expect(permissions.migrateToGlobalRules(context)).rejects.toThrow('disk full');
    await expect(permissions.check('https://site.example', 'getPublicKey', undefined, 'alice')).rejects.toThrow('migration incomplete');
    fail = false;
    const restored = new Permissions(store);
    await restored.migrateToGlobalRules(context);
    expect(await restored.check('https://site.example', 'getPublicKey', undefined, 'alice')).toBe('allow');
  });

  test('settings resets preserve authentication while account removal revokes it', async () => {
    const permissions = new Permissions(new MemoryStore());
    await permissions.migrateToGlobalRules(context);
    await permissions.authentication.save('alice', 'https://site.example', request, 'site', () => {});
    await permissions.authentication.setDefaultBackendAuth('alice', true);
    await permissions.saveDirect(GLOBAL_RULES_SCOPE, 'getPublicKey', 'allow', DEFAULT_BUCKET);
    await permissions.saveDirect('https://site.example', 'getPublicKey', 'deny', 'alice');
    await permissions.clearRuleBucket('https://site.example', 'alice');
    await permissions.resetAccountRules();
    expect(await permissions.authentication.isAllowed('alice', 'https://site.example', request)).toBe(true);
    expect(await permissions.check('https://site.example', 'getPublicKey', undefined, 'alice')).toBe('allow');
    await permissions.clearForAccount('alice');
    expect(await permissions.authentication.list()).toEqual([]);
    expect(await permissions.authentication.getDefaultBackendAuth('alice')).toBe(false);
  });
});

describe('host authentication policy', () => {
  test('legacy login is opt-in, exact-origin and once-only', async () => {
    const event = { kind: 22242, content: '', created_at: 100, tags: [['domain', 'login.example'], ['challenge', 'nonce']] };
    expect(() => parseAuthentication(event, 'https://login.example', 100)).toThrow();
    const options = { legacyLoginOrigins: ['https://login.example'] };
    const auth = parseAuthentication(event, 'https://login.example', 100, options)!;
    expect(auth.protocol).toBe('legacy-login');
    expect(validAuthenticationScope(auth, 'once')).toBe(true);
    expect(validAuthenticationScope(auth, 'site')).toBe(false);
    expect(() => parseAuthentication(event, 'https://other.example', 100, options)).toThrow();
    expect(() => parseAuthentication({ ...event, created_at: 39 }, 'https://login.example', 100, options)).toThrow();
    expect(() => parseAuthentication({ ...event, tags: [...event.tags, ['extra', 'x']] }, 'https://login.example', 100, options)).toThrow();
    expect(() => parseAuthentication({ ...event, tags: [['domain', 'login.example'], ['challenge', ' ']] }, 'https://login.example', 100, options)).toThrow();
    const grants = new AuthenticationGrants(new MemoryStore());
    await grants.setDefaultBackendAuth('alice', true);
    expect(await grants.decisionFor('alice', 'https://login.example', auth)).toBeUndefined();
    await expect(grants.save('alice', 'https://login.example', auth, 'site', () => {})).rejects.toThrow();
    await grants.save('alice', 'https://login.example', auth, 'once', () => {});
    expect(await grants.list()).toEqual([]);
  });

  test('backend defaults require account opt-in and exact registry pairs; denies override them', async () => {
    const grants = new AuthenticationGrants(new MemoryStore(), {
      backendRegistry: [{ origin: 'https://site.example', destination: 'https://api.example', protocol: 'nip98' }],
    });
    expect(await grants.decisionFor('alice', 'https://site.example', request)).toBeUndefined();
    await grants.setDefaultBackendAuth('alice', true);
    expect(await grants.decisionFor('alice', 'https://site.example', request)).toBe('allow');
    expect(await grants.decisionFor('bob', 'https://site.example', request)).toBeUndefined();
    expect(await grants.decisionFor('alice', 'https://other.example', request)).toBeUndefined();
    expect(await grants.decisionFor('alice', 'https://SITE.example', request)).toBeUndefined();
    expect(await grants.decisionFor('alice', 'https://api.example', request)).toBe('allow');
    await grants.save('alice', 'https://site.example', request, 'site', () => {}, 'deny');
    expect(await grants.decisionFor('alice', 'https://site.example', request)).toBe('deny');
    await grants.revoke({ origin: 'https://site.example' });
    expect(await grants.getDefaultBackendAuth('alice')).toBe(true);
    await grants.revoke();
    expect(await grants.getDefaultBackendAuth('alice')).toBe(false);
  });
});
