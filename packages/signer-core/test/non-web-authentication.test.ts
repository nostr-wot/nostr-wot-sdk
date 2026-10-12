/**
 * Authentication for requesters that are not web pages, through the whole pipeline: a NIP-46
 * client, an Android package, a LAN peer and the host app itself.
 *
 * What is held here and nowhere else:
 *
 *   - a non-web requester authenticates only through a host-supplied `requesterFor`, cannot
 *     claim an origin, and is keyed so that no grant of its can meet a web origin's;
 *   - with a grant store configured, consent is stored per destination and per requester (or
 *     for every requester, relays only), a stored deny refuses before any prompt, a stored
 *     allow skips it, a revocation in flight refuses the signature, and a remembered refusal
 *     is destination-scoped rather than a blanket kind deny;
 *   - a web requester keeps the extension's behaviour under every configuration unless the
 *     host adds `'web'` to `rememberFor` on purpose;
 *   - the host's own relay login runs only through `handleSelf`, never through `handle`, with
 *     no prompt and no grant, and is written to the activity log as such.
 *
 * `authentication.test.ts` holds the web path and is untouched; this file is the addition.
 */
import { describe, expect, test, vi } from 'vitest';
import { MemoryStore } from '@nostr-wot/storage';
import { AUTHENTICATION_GRANTS_KEY, Permissions, SHARED_SITES_ORIGIN, type AuthenticationGrant } from '@nostr-wot/permissions';
import {
  SignerCore,
  authenticationRequesterKey,
  permissionOrigin,
  requesterOf,
  type ActivityEntry,
  type ApprovalDecision,
  type AuthenticationGrantsPort,
  type AuthenticationPolicy,
  type AuthenticationRequester,
  type RequestOrigin,
  type SignerRequest,
  type UnlockPort,
} from '../src/index.js';
import { account, fixture, type FixtureOptions, PASSWORD, PRIVKEY_1, PUBKEY_1, remoteSigned, req } from './harness.js';

const PUBKEY = 'ab'.repeat(32);
const ANDROID: RequestOrigin = { kind: 'nip55', identifier: 'com.example.client' };
const OTHER_ANDROID: RequestOrigin = { kind: 'nip55', identifier: 'com.example.other' };
const CLIENT: RequestOrigin = { kind: 'nip46', identifier: PUBKEY };
const PEER: RequestOrigin = { kind: 'lan', identifier: 'peer-1' };
const APP: RequestOrigin = { kind: 'local', identifier: 'nostr-wot-wallet' };
const PQ: RequestOrigin = { kind: 'local', identifier: 'post-quantum' };
const WEB: RequestOrigin = { kind: 'web', identifier: 'https://example.com' };
const SELF: AuthenticationRequester[] = [{ kind: 'local', id: 'nostr-wot-wallet' }, { kind: 'local', id: 'post-quantum' }];

/** The resolver a host whose transports attest identity before building the request would write. */
const attested: AuthenticationPolicy['requesterFor'] = async (request) => requesterOf(request.origin);

function authRequest(origin: RequestOrigin, kind = 22242, tags?: string[][], now = Date.now()): SignerRequest {
  const request = req('signEvent', {
    kind,
    content: '',
    created_at: Math.floor(now / 1000),
    tags:
      tags ??
      (kind === 27235
        ? [['u', 'https://api.example.com/login?nonce=1'], ['method', 'POST']]
        : [['relay', 'wss://relay.example.com'], ['challenge', 'challenge']]),
  });
  request.origin = { ...origin };
  return request;
}

const once = async (): Promise<ApprovalDecision> => ({ allow: true, authenticationScope: 'once' });
const site = async (): Promise<ApprovalDecision> => ({ allow: true, authenticationScope: 'site' });
const shared = async (): Promise<ApprovalDecision> => ({ allow: true, authenticationScope: 'connected-sites' });

/** A core over a real `Permissions`, whose own grant store is the policy's. */
async function withGrants(approve: boolean | 'never', policy: Partial<AuthenticationPolicy> = {}, options: FixtureOptions = {}) {
  const store = new MemoryStore();
  const permissions = new Permissions(store);
  const built = await fixture(approve, {
    ...options,
    permissions,
    authentication: { requesterFor: attested, grants: permissions.authentication, ...policy },
  });
  const grants = async () => (await store.get<AuthenticationGrant[]>(AUTHENTICATION_GRANTS_KEY)) ?? [];
  return { ...built, store, grants };
}

describe('who is asking', () => {
  test('requesterOf spells every origin kind exactly as permissionOrigin does, so one grant list serves both', () => {
    for (const origin of [WEB, CLIENT, ANDROID, PEER, APP]) {
      expect(authenticationRequesterKey(requesterOf(origin))).toBe(permissionOrigin(origin));
    }
  });

  test('a non-web requester authenticates through requesterFor and nothing else', async () => {
    const strict = await fixture(true);
    strict.approval.decide = once;
    await expect(strict.core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(strict.approval.presented).toHaveLength(0);

    const { core, approval, vault } = await fixture(true, { authentication: { requesterFor: attested } });
    approval.decide = once;
    const key = vi.spyOn(vault, 'withPrivkey');
    for (const origin of [ANDROID, CLIENT, PEER, APP]) {
      await expect(core.handle(authRequest(origin))).resolves.toHaveProperty('sig');
      await expect(core.handle(authRequest(origin, 27235))).resolves.toHaveProperty('sig');
    }
    expect(key).toHaveBeenCalledTimes(8);
    expect(approval.presented).toHaveLength(8);
  });

  test('the prompt is told the requester key and that only once is on offer', async () => {
    const { core, approval } = await fixture(true, { authentication: { requesterFor: attested } });
    const present = vi.spyOn(approval, 'present');
    approval.decide = once;
    await core.handle(authRequest(CLIENT));
    expect(present.mock.calls[0]![2]).toMatchObject({ requester: `nip46:${PUBKEY}`, scopes: ['once'] });
    expect(present.mock.calls[0]![2]!.authentication).toMatchObject({ protocol: 'nip42', destination: 'wss://relay.example.com/', crossOrigin: true });
  });

  test('a non-web requester cannot claim an origin: the tag refuses the event before any prompt or key use', async () => {
    const { core, approval, vault } = await fixture(true, { authentication: { requesterFor: attested } });
    approval.decide = once;
    const key = vi.spyOn(vault, 'withPrivkey');
    for (const origin of [ANDROID, CLIENT, PEER, APP]) {
      for (const name of ['origin', 'client-origin']) {
        const relay = authRequest(origin, 22242, [['relay', 'wss://relay.example.com'], ['challenge', 'c'], [name, 'https://example.com']]);
        await expect(core.handle(relay)).rejects.toMatchObject({ code: 'invalid_request' });
        const http = authRequest(origin, 27235, [['u', 'https://api.example.com/login'], ['method', 'POST'], [name, 'nip55:com.example.client']]);
        await expect(core.handle(http)).rejects.toMatchObject({ code: 'invalid_request' });
      }
    }
    expect(approval.presented).toHaveLength(0);
    expect(key).not.toHaveBeenCalled();
  });

  test('a non-web HTTP credential is always cross-origin, whatever the destination', async () => {
    const { core, approval } = await fixture(true, { authentication: { requesterFor: attested } });
    const present = vi.spyOn(approval, 'present');
    approval.decide = once;
    // The package name is spelled like the destination's origin; nothing an app is can equal a destination.
    const request = authRequest({ kind: 'nip55', identifier: 'https://api.example.com' }, 27235);
    await core.handle(request);
    expect(present.mock.calls[0]![2]!.authentication.crossOrigin).toBe(true);
  });

  test('a resolver that cannot vouch for a caller refuses it, and a malformed requester is invalid', async () => {
    const refusing: AuthenticationPolicy['requesterFor'] = async (request) => {
      if (request.origin.kind === 'lan') throw new Error('LAN peers are not attested on this host');
      if (request.origin.kind === 'nip46') return { kind: 'nip46', clientPubkey: 'not-hex' };
      return requesterOf(request.origin);
    };
    const { core, approval } = await fixture(true, { authentication: { requesterFor: refusing } });
    approval.decide = once;
    await expect(core.handle(authRequest(PEER))).rejects.toMatchObject({ code: 'internal' });
    await expect(core.handle(authRequest(CLIENT))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(1);
  });

  test('the two resolvers are exclusive', async () => {
    const built = await fixture(true);
    expect(
      () =>
        new SignerCore({
          vault: built.vault,
          permissions: built.permissions,
          approval: built.approval,
          activity: built.activity,
          identity: built.identity,
          authentication: { requesterFor: attested, originFor: async () => 'https://example.com' },
        }),
    ).toThrow('not both');
  });
});

describe('stored consent for a non-web requester', () => {
  test('a site-scoped approval is written after revalidation and answers the next request without a prompt', async () => {
    const { core, approval, vault, activity, grants } = await withGrants(true);
    approval.decide = site;
    const key = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(1);
    expect(await grants()).toEqual([
      {
        decision: 'allow',
        accountId: 'acct_1',
        origin: 'nip55:com.example.client',
        protocol: 'nip42',
        destination: 'wss://relay.example.com/',
        id: JSON.stringify(['acct_1', 'nip55:com.example.client', 'nip42', 'wss://relay.example.com/', '']),
      },
    ]);
    // The same requester, the same relay: no prompt. Another requester, the same relay: a prompt.
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(1);
    await expect(core.handle(authRequest(OTHER_ANDROID))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(2);
    // Another relay from the first requester: a prompt.
    await expect(core.handle(authRequest(ANDROID, 22242, [['relay', 'wss://other.example.com'], ['challenge', 'c']]))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(3);
    expect(key).toHaveBeenCalledTimes(4);
    const consents = activity.entries.map((entry) => entry.authentication?.consent);
    expect(consents).toEqual(['site', 'grant', 'site', 'site']);
  });

  test('an HTTP consent binds the exact signed URL and method; every-requester scope is not offered for it', async () => {
    const { core, approval, grants } = await withGrants(true);
    const present = vi.spyOn(approval, 'present');
    approval.decide = site;
    await core.handle(authRequest(CLIENT, 27235));
    expect(present.mock.calls[0]![2]!.scopes).toEqual(['once', 'site']);
    expect(await grants()).toMatchObject([{ origin: `nip46:${PUBKEY}`, protocol: 'nip98', version: 2, resource: 'https://api.example.com/login?nonce=1', method: 'POST' }]);
    await core.handle(authRequest(CLIENT, 27235));
    expect(present).toHaveBeenCalledTimes(1);
    await core.handle(authRequest(CLIENT, 27235, [['u', 'https://api.example.com/transfer'], ['method', 'POST']]));
    await core.handle(authRequest(CLIENT, 27235, [['u', 'https://api.example.com/login?nonce=1'], ['method', 'GET']]));
    expect(present).toHaveBeenCalledTimes(3);
    approval.decide = shared;
    await expect(core.handle(authRequest(CLIENT, 27235, [['u', 'https://api.example.com/other'], ['method', 'POST']]))).rejects.toMatchObject({ code: 'rejected' });
    expect(await grants()).toHaveLength(3);
  });

  test('a relay consent for every requester is honoured for every kind, and a requester deny still wins', async () => {
    const { core, approval, grants } = await withGrants(true);
    const present = vi.spyOn(approval, 'present');
    approval.decide = shared;
    await core.handle(authRequest(ANDROID));
    expect(present.mock.calls[0]![2]!.scopes).toEqual(['once', 'site', 'connected-sites']);
    expect(await grants()).toMatchObject([{ origin: SHARED_SITES_ORIGIN, protocol: 'nip42' }]);
    for (const origin of [CLIENT, PEER, OTHER_ANDROID]) await expect(core.handle(authRequest(origin))).resolves.toHaveProperty('sig');
    expect(present).toHaveBeenCalledTimes(1);
    // The user refuses one peer for good: that peer is refused from then on, everyone else is not.
    approval.decide = async () => ({ allow: false, remember: true });
    await expect(core.handle(authRequest(PEER, 22242, [['relay', 'wss://second.example.com'], ['challenge', 'c']]))).rejects.toMatchObject({ code: 'rejected' });
    approval.decide = shared;
    await core.handle(authRequest(ANDROID, 22242, [['relay', 'wss://second.example.com'], ['challenge', 'c']]));
    await expect(core.handle(authRequest(PEER, 22242, [['relay', 'wss://second.example.com'], ['challenge', 'c']]))).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(core.handle(authRequest(CLIENT, 22242, [['relay', 'wss://second.example.com'], ['challenge', 'c']]))).resolves.toHaveProperty('sig');
  });

  test('a stored deny refuses before any prompt, and a remembered refusal is destination-scoped, not a kind deny', async () => {
    const { core, approval, vault, permissions, grants } = await withGrants(true);
    const save = vi.spyOn(permissions, 'save');
    const key = vi.spyOn(vault, 'withPrivkey');
    approval.decide = async () => ({ allow: false, remember: true, reason: 'No' });
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'rejected', message: 'No' });
    expect(save).not.toHaveBeenCalled();
    expect(await grants()).toEqual([
      {
        decision: 'deny',
        accountId: 'acct_1',
        origin: 'nip55:com.example.client',
        protocol: 'nip42',
        destination: 'wss://relay.example.com/',
        id: JSON.stringify(['acct_1', 'nip55:com.example.client', 'nip42', 'wss://relay.example.com/', '']),
      },
    ]);
    approval.decide = once;
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(approval.presented).toHaveLength(1);
    expect(key).not.toHaveBeenCalled();
    // The same requester at another relay, and the cascade's own kind rule, are untouched.
    await expect(core.handle(authRequest(ANDROID, 22242, [['relay', 'wss://other.example.com'], ['challenge', 'c']]))).resolves.toHaveProperty('sig');
    expect(await permissions.check('nip55:com.example.client', 'signEvent', 22242, 'acct_1')).toBe('ask');
  });

  test('a refusal whose rejection cannot be remembered is still a refusal, and says so', async () => {
    const failing: AuthenticationGrantsPort = {
      decisionFor: async () => undefined,
      save: async () => {
        throw new Error('disk full');
      },
    };
    const { core, approval } = await fixture(true, { authentication: { requesterFor: attested, grants: failing } });
    approval.decide = async () => ({ allow: false, remember: true });
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'rejected', message: expect.stringContaining('could not be remembered') });
  });

  test('a deny recorded while the prompt was open wins over the approval', async () => {
    const { core, approval, vault, permissions } = await withGrants(true);
    const key = vi.spyOn(vault, 'withPrivkey');
    approval.decide = async (request) => {
      const auth = { protocol: 'nip42' as const, url: 'wss://relay.example.com', destination: 'wss://relay.example.com/', crossOrigin: true };
      await permissions.authentication.save('acct_1', permissionOrigin(request.origin), auth, 'site', () => {}, 'deny');
      return site();
    };
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(key).not.toHaveBeenCalled();
  });

  test('a stored allow revoked during the unlock refuses the signature; a fresh approval is not', async () => {
    const vaultRef: { current: { unlock(password: string): Promise<unknown> } | null } = { current: null };
    let revokeOnUnlock = false;
    let permissionsRef: Permissions | null = null;
    const unlock: UnlockPort = {
      async requestUnlock() {
        await vaultRef.current!.unlock(PASSWORD);
        if (revokeOnUnlock) await permissionsRef!.authentication.revoke({ origin: 'nip55:com.example.client' });
      },
    };
    const built = await withGrants(true, {}, { unlock });
    vaultRef.current = built.vault;
    permissionsRef = built.permissions;
    const { core, approval, vault, activity } = built;
    approval.decide = site;
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
    // Riding the stored allow, revoked while the user typed the password: refused.
    vault.lock();
    revokeOnUnlock = true;
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied', message: 'Authentication permission revoked' });
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', authentication: { consent: 'grant' } });
    // A fresh approval is not refused by a revocation of the grant it just wrote.
    vault.lock();
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(2);
  });

  test('a stored allow revoked during the signature drops the result', async () => {
    const { core, approval, vault, permissions } = await withGrants(true);
    approval.decide = site;
    await core.handle(authRequest(ANDROID));
    const original = vault.withPrivkey.bind(vault);
    vi.spyOn(vault, 'withPrivkey').mockImplementationOnce(async (accountId, fn) => {
      const result = await original(accountId, fn);
      await permissions.authentication.revoke({ origin: 'nip55:com.example.client' });
      return result;
    });
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('a consent is not written when the approval outlives the token', async () => {
    let now = Date.now();
    const { core, approval, grants } = await withGrants(true, {}, { now: () => now });
    approval.decide = async () => {
      now += 120_000;
      return site();
    };
    await expect(core.handle(authRequest(ANDROID, 27235))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await grants()).toEqual([]);
  });

  test('a store that fails to record an approval refuses the signature as internal', async () => {
    const broken: AuthenticationGrantsPort = {
      decisionFor: async () => undefined,
      save: async () => {
        throw new Error('/var/data/grants.db is read-only');
      },
    };
    const logger = { warn: vi.fn() };
    const { core, approval, vault } = await fixture(true, { logger, authentication: { requesterFor: attested, grants: broken } });
    approval.decide = site;
    const key = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'internal' });
    expect(key).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('authentication grant not saved', expect.objectContaining({ requester: 'nip55:com.example.client' }));
    // And `once` writes nothing, so it does not depend on the store at all.
    approval.decide = once;
    await expect(core.handle(authRequest(ANDROID))).resolves.toHaveProperty('sig');
  });

  test('a remote account honours a stored allow and a stored deny like a local one', async () => {
    const execute = vi.fn(async (_account, _request, params) => remoteSigned(params.event, PRIVKEY_1));
    const remoteAccount = { ...account('remote', PRIVKEY_1), type: 'nip46' as const };
    const { core, approval } = await withGrants(true, {}, { accounts: [remoteAccount], remote: { execute } });
    approval.decide = site;
    await core.handle(authRequest(ANDROID));
    await core.handle(authRequest(ANDROID));
    expect(approval.presented).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('rememberFor narrows which kinds may be remembered; a stored deny still refuses the rest', async () => {
    const { core, approval, grants, permissions } = await withGrants(true, { rememberFor: ['nip46'] });
    const present = vi.spyOn(approval, 'present');
    approval.decide = site;
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'rejected', message: 'Explicit one-time authentication approval required' });
    expect(present.mock.calls[0]![2]!.scopes).toEqual(['once']);
    expect(await grants()).toEqual([]);
    await expect(core.handle(authRequest(CLIENT))).resolves.toHaveProperty('sig');
    expect(await grants()).toHaveLength(1);
    const auth = { protocol: 'nip42' as const, url: 'wss://relay.example.com', destination: 'wss://relay.example.com/', crossOrigin: true };
    await permissions.authentication.save('acct_1', 'nip55:com.example.client', auth, 'site', () => {}, 'deny');
    approval.decide = once;
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(present).toHaveBeenCalledTimes(2);
  });

  test('rememberFor without a store, or with an unknown kind, is refused at construction', async () => {
    const built = await fixture(true);
    const deps = { vault: built.vault, permissions: built.permissions, approval: built.approval, activity: built.activity, identity: built.identity };
    expect(() => new SignerCore({ ...deps, authentication: { rememberFor: ['nip55'] } })).toThrow('needs authentication.grants');
    expect(
      () => new SignerCore({ ...deps, authentication: { grants: built.permissions.authentication, rememberFor: ['evil' as 'nip55'] } }),
    ).toThrow('Unknown authentication requester kind');
  });
});

describe('a web requester keeps the extension\'s behaviour', () => {
  test('with a grant store configured, a page still prompts every time and only once is accepted', async () => {
    const { core, approval, grants, permissions } = await withGrants(true);
    const present = vi.spyOn(approval, 'present');
    approval.decide = site;
    await expect(core.handle(authRequest(WEB))).rejects.toMatchObject({ code: 'rejected', message: 'Explicit one-time authentication approval required' });
    expect(present.mock.calls[0]![2]).toMatchObject({ requester: 'https://example.com', scopes: ['once'] });
    expect(await grants()).toEqual([]);
    approval.decide = once;
    await expect(core.handle(authRequest(WEB))).resolves.toHaveProperty('sig');
    // A stored allow for the page, written by the host's own screens, does not skip the prompt.
    const auth = { protocol: 'nip42' as const, url: 'wss://relay.example.com', destination: 'wss://relay.example.com/', crossOrigin: true };
    await permissions.authentication.save('acct_1', 'https://example.com', auth, 'site', () => {});
    await expect(core.handle(authRequest(WEB))).resolves.toHaveProperty('sig');
    expect(present).toHaveBeenCalledTimes(3);
    // A stored deny for the page does refuse: a refusal in force is a refusal in force.
    await permissions.authentication.revoke({ origin: 'https://example.com' });
    await permissions.authentication.save('acct_1', 'https://example.com', auth, 'site', () => {}, 'deny');
    await expect(core.handle(authRequest(WEB))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(present).toHaveBeenCalledTimes(3);
  });

  test('a host may add web to rememberFor on purpose', async () => {
    const { core, approval, grants } = await withGrants(true, { rememberFor: ['web', 'nip55'] });
    approval.decide = site;
    await expect(core.handle(authRequest(WEB))).resolves.toHaveProperty('sig');
    expect(await grants()).toMatchObject([{ origin: 'https://example.com', protocol: 'nip42' }]);
    await expect(core.handle(authRequest(WEB))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(1);
  });

  test('a grant for a page can never answer for an app spelled like it, nor the reverse', async () => {
    const { core, approval, permissions } = await withGrants(true, { rememberFor: ['web', 'nip55', 'local'] });
    approval.decide = site;
    const auth = { protocol: 'nip42' as const, url: 'wss://relay.example.com', destination: 'wss://relay.example.com/', crossOrigin: true };
    await permissions.authentication.save('acct_1', 'https://example.com', auth, 'site', () => {});
    await permissions.authentication.save('acct_1', 'nip55:com.example.client', auth, 'site', () => {});
    // An app that names itself after the page, and a label that names itself after the app.
    for (const origin of [
      { kind: 'nip55', identifier: 'https://example.com' } as RequestOrigin,
      { kind: 'local', identifier: 'https://example.com' } as RequestOrigin,
      { kind: 'local', identifier: 'nip55:com.example.client' } as RequestOrigin,
    ]) {
      await expect(core.handle(authRequest(origin))).resolves.toHaveProperty('sig');
    }
    expect(approval.presented).toHaveLength(3);
    // And a page cannot spell an app's key at all: the boundary refuses the colon.
    await expect(core.handle(authRequest({ kind: 'web', identifier: 'nip55:com.example.client' }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('without a grant store the web path is exactly what it was: originFor still resolves a page', async () => {
    const { core, approval, permissions } = await fixture(true, { authentication: { originFor: async () => 'https://example.com' } });
    const save = vi.spyOn(permissions, 'save');
    approval.decide = site;
    const request = authRequest(ANDROID);
    await expect(core.handle(request)).rejects.toMatchObject({ code: 'rejected', message: 'Explicit one-time authentication approval required' });
    approval.decide = async () => ({ allow: false, remember: true });
    await expect(core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'rejected' });
    expect(save).toHaveBeenCalledWith('nip55:com.example.client', 'signEvent', 22242, 'deny', 'acct_1');
  });
});

describe('the host\'s own relay login', () => {
  const selfPolicy = (extra: Partial<AuthenticationPolicy> = {}): AuthenticationPolicy => ({
    requesterFor: attested,
    self: { requesters: SELF },
    ...extra,
  });

  test('handleSelf signs a relay login with no prompt and no grant, and the log says so', async () => {
    const { core, approval, vault, activity, grants } = await withGrants(true, selfPolicy());
    const key = vi.spyOn(vault, 'withPrivkey');
    for (const origin of [APP, PQ]) await expect(core.handleSelf(authRequest(origin))).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(0);
    expect(key).toHaveBeenCalledTimes(2);
    expect(await grants()).toEqual([]);
    expect(activity.entries.map((entry) => entry.authentication)).toEqual([
      { protocol: 'nip42', destination: 'wss://relay.example.com/', requester: 'local:nostr-wot-wallet', consent: 'self' },
      { protocol: 'nip42', destination: 'wss://relay.example.com/', requester: 'local:post-quantum', consent: 'self' },
    ]);
    expect(activity.entries.every((entry) => entry.decision === 'allow')).toBe(true);
  });

  test('the same request through handle is refused: the self path is not reachable by request', async () => {
    const { core, approval, vault, activity } = await withGrants(true, selfPolicy());
    approval.decide = once;
    const key = vi.spyOn(vault, 'withPrivkey');
    for (const origin of [APP, PQ]) {
      await expect(core.handle(authRequest(origin))).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(core.handle(authRequest(origin, 27235))).rejects.toMatchObject({ code: 'permission_denied' });
    }
    expect(approval.presented).toHaveLength(0);
    expect(key).not.toHaveBeenCalled();
    expect(activity.entries).toHaveLength(4);
    expect(activity.entries.every((entry) => entry.decision === 'deny' && entry.authentication === undefined)).toBe(true);
    // A resolver that routes a foreign caller onto the host's identity is refused the same way.
    const routed = await withGrants(true, selfPolicy({ requesterFor: async () => SELF[0]! }));
    routed.approval.decide = once;
    await expect(routed.core.handle(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(routed.approval.presented).toHaveLength(0);
  });

  test('an ordinary signature from the host\'s own origin through handle is unchanged', async () => {
    const { core, approval } = await withGrants(true, selfPolicy());
    const request = req('signEvent', { kind: 1, content: 'a record' });
    request.origin = { ...APP };
    await expect(core.handle(request)).resolves.toHaveProperty('sig');
    expect(approval.presented).toHaveLength(1);
  });

  test('handleSelf takes a relay login from a declared requester, and nothing else', async () => {
    const { core, approval, vault, activity } = await withGrants(true, selfPolicy());
    const key = vi.spyOn(vault, 'withPrivkey');
    // Not the host: a transport that reached the method is refused, and the attempt is logged.
    await expect(core.handleSelf(authRequest(ANDROID))).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(core.handleSelf(authRequest(WEB))).rejects.toMatchObject({ code: 'permission_denied' });
    // Not a relay login: an HTTP token is a bearer credential and never silent.
    await expect(core.handleSelf(authRequest(APP, 27235))).rejects.toMatchObject({ code: 'permission_denied' });
    // Not an authentication event at all.
    const note = req('signEvent', { kind: 1 });
    note.origin = { ...APP };
    await expect(core.handleSelf(note)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(core.handleSelf({ ...req('getPublicKey'), origin: { ...APP } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(approval.presented).toHaveLength(0);
    expect(key).not.toHaveBeenCalled();
    expect(activity.entries.filter((entry) => entry.decision === 'deny')).toHaveLength(3);
  });

  test('without a self policy handleSelf is unsupported', async () => {
    const { core } = await fixture(true, { authentication: { requesterFor: attested } });
    await expect(core.handleSelf(authRequest(APP))).rejects.toMatchObject({ code: 'unsupported' });
  });

  test('a web requester cannot be the host, and the host must name at least one', async () => {
    const built = await fixture(true);
    const deps = { vault: built.vault, permissions: built.permissions, approval: built.approval, activity: built.activity, identity: built.identity };
    expect(() => new SignerCore({ ...deps, authentication: { self: { requesters: [{ kind: 'web', origin: 'https://example.com' }] } } })).toThrow('web');
    expect(() => new SignerCore({ ...deps, authentication: { self: { requesters: [] } } })).toThrow('at least one');
  });

  test('a cascade deny, a stored deny and the host\'s own policy still refuse the self path', async () => {
    const policy = vi.fn(async () => {});
    const { core, vault, permissions } = await withGrants(true, selfPolicy({ assertAllowed: policy }));
    const key = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handleSelf(authRequest(APP))).resolves.toHaveProperty('sig');
    expect(policy).toHaveBeenCalledTimes(3);
    const auth = { protocol: 'nip42' as const, url: 'wss://relay.example.com', destination: 'wss://relay.example.com/', crossOrigin: true };
    await permissions.authentication.save('acct_1', 'local:nostr-wot-wallet', auth, 'site', () => {}, 'deny');
    await expect(core.handleSelf(authRequest(APP))).rejects.toMatchObject({ code: 'permission_denied' });
    await permissions.authentication.revoke();
    await permissions.save('local:nostr-wot-wallet', 'signEvent', 22242, 'deny', 'acct_1');
    await expect(core.handleSelf(authRequest(APP))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(key).toHaveBeenCalledTimes(1);
    policy.mockRejectedValueOnce(new Error('Relay not in the user\'s list'));
    await permissions.clearAllForOrigin('local:nostr-wot-wallet');
    await expect(core.handleSelf(authRequest(APP))).rejects.toBeDefined();
    expect(key).toHaveBeenCalledTimes(1);
  });

  test('the self path goes through the unlock and the revalidations like any other request', async () => {
    const vaultRef: { current: { unlock(password: string): Promise<unknown> } | null } = { current: null };
    const unlock: UnlockPort = {
      async requestUnlock() {
        await vaultRef.current!.unlock(PASSWORD);
      },
    };
    let now = Date.now();
    const built = await withGrants(true, selfPolicy(), { unlock, locked: true, now: () => now });
    vaultRef.current = built.vault;
    await expect(built.core.handleSelf(authRequest(APP, 22242, undefined, now))).resolves.toHaveProperty('sig');
    built.vault.lock();
    unlock.requestUnlock = async () => {
      await vaultRef.current!.unlock(PASSWORD);
      now += 700_000;
    };
    await expect(built.core.handleSelf(authRequest(APP, 22242, undefined, now))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('a self login signs the account the host asked for', async () => {
    const { core } = await withGrants(true, selfPolicy());
    const signed = (await core.handleSelf(authRequest(APP))) as { pubkey: string; kind: number; tags: string[][] };
    expect(signed.pubkey).toBe(PUBKEY_1);
    expect(signed.kind).toBe(22242);
    expect(signed.tags).toEqual([['relay', 'wss://relay.example.com'], ['challenge', 'challenge']]);
  });
});

describe('the activity log', () => {
  test('an authentication entry names protocol, destination and requester, and a refused one carries no consent', async () => {
    const { core, approval, activity } = await withGrants(true);
    approval.decide = once;
    await core.handle(authRequest(CLIENT, 27235));
    approval.decide = async () => ({ allow: false });
    await expect(core.handle(authRequest(CLIENT, 27235))).rejects.toMatchObject({ code: 'rejected' });
    const [allowed, refused] = activity.entries as [ActivityEntry, ActivityEntry];
    expect(allowed.authentication).toEqual({ protocol: 'nip98', destination: 'https://api.example.com', method: 'POST', requester: `nip46:${PUBKEY}`, consent: 'once' });
    expect(refused.authentication).toEqual({ protocol: 'nip98', destination: 'https://api.example.com', method: 'POST', requester: `nip46:${PUBKEY}` });
    expect(refused.decision).toBe('deny');
  });

  test('an ordinary entry carries no authentication field', async () => {
    const { core, activity } = await withGrants(true);
    await core.handle(req('signEvent', { kind: 1 }));
    expect(activity.entries[0]).not.toHaveProperty('authentication');
  });
});
