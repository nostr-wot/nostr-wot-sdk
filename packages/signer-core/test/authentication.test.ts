import { describe, expect, test, vi } from 'vitest';
import { type SignerRequest } from '../src/index.js';
import { account, fixture, PRIVKEY_1, remoteSigned, req } from './harness.js';

function authRequest(kind = 27235, tags?: string[][]): SignerRequest {
  const request = req('signEvent', {
    kind, content: '', created_at: Math.floor(Date.now() / 1000),
    tags: tags ?? (kind === 27235
      ? [['u', 'https://api.example.com/login?nonce=1'], ['method', 'POST']]
      : [['relay', 'wss://relay.example.com'], ['challenge', 'challenge']]),
  });
  request.origin.identifier = 'https://example.com';
  return request;
}

const consent = async () => ({ allow: true, authenticationScope: 'once' as const });

describe('destination authentication at the shared signer boundary', () => {
  test('malformed and ambiguous credentials fail before prompting or using a key', async () => {
    const { core, vault, approval } = await fixture(true);
    const key = vi.spyOn(vault, 'withPrivkey');
    for (const tags of [[], [['u', 'https://api.example.com/login'], ['method', 'POST'], ['method', 'GET']]]) {
      await expect(core.handle(authRequest(27235, tags))).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(approval.presented).toHaveLength(0);
    expect(key).not.toHaveBeenCalled();
  });

  test('host permission allows cannot bypass destination disclosure or explicit one-time consent', async () => {
    const { core, approval, permissions, vault } = await fixture(true);
    vi.spyOn(permissions, 'check').mockResolvedValue('allow');
    const present = vi.spyOn(approval, 'present');
    const key = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'rejected' });
    expect(key).not.toHaveBeenCalled();
    approval.decide = consent;
    await core.handle(authRequest());
    expect(present).toHaveBeenCalledTimes(2);
    const context = present.mock.calls[1]![2]!;
    expect(context.authentication).toMatchObject({ protocol: 'nip98', url: 'https://api.example.com/login?nonce=1', method: 'POST', crossOrigin: true });
    expect(Object.isFrozen(context.authentication)).toBe(true);
  });

  test('remote signing requires the same local authentication approval', async () => {
    const execute = vi.fn(async (_account, _request, params) => remoteSigned(params.event, PRIVKEY_1));
    const remoteAccount = { ...account('remote', PRIVKEY_1), type: 'nip46' as const };
    const { core, approval } = await fixture(true, { accounts: [remoteAccount], remote: { execute } });
    await expect(core.handle(authRequest(22242))).rejects.toMatchObject({ code: 'rejected' });
    expect(execute).not.toHaveBeenCalled();
    approval.decide = consent;
    await core.handle(authRequest(22242));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('an approval that outlives the timestamp is not signed', async () => {
    let now = Date.now();
    const { core, approval, vault } = await fixture(true, { now: () => now });
    const key = vi.spyOn(vault, 'withPrivkey');
    approval.decide = async () => { now += 120_000; return consent(); };
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(key).not.toHaveBeenCalled();
  });

  test('policy is checked after approval and a new denial prevents signing', async () => {
    let allowed = true;
    const policy = vi.fn(async () => { if (!allowed) throw new Error('Host disconnected'); });
    const { core, approval, vault } = await fixture(true, { authentication: { assertAllowed: policy } });
    const key = vi.spyOn(vault, 'withPrivkey');
    approval.decide = async () => { allowed = false; return consent(); };
    await expect(core.handle(authRequest())).rejects.toBeDefined();
    expect(policy).toHaveBeenCalledTimes(2);
    expect(key).not.toHaveBeenCalled();
  });

  test('a remembered deny added during approval wins', async () => {
    const { core, approval, vault, permissions } = await fixture(true);
    const key = vi.spyOn(vault, 'withPrivkey');
    approval.decide = async () => {
      await permissions.save('https://example.com', 'signEvent', 27235, 'deny', 'acct_1');
      return consent();
    };
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'permission_denied' });
    expect(key).not.toHaveBeenCalled();
  });

  test('legacy compatibility is opt-in, disclosed, and cannot be remembered', async () => {
    const request = () => authRequest(22242, [['domain', 'example.com'], ['challenge', 'challenge']]);
    const strict = await fixture(true);
    await expect(strict.core.handle(request())).rejects.toMatchObject({ code: 'invalid_request' });
    const { core, approval, permissions } = await fixture(true, { authentication: { legacyLoginOrigins: ['https://example.com'] } });
    const save = vi.spyOn(permissions, 'save');
    const present = vi.spyOn(approval, 'present');
    approval.decide = async () => ({ ...await consent(), remember: true });
    await core.handle(request());
    await core.handle(request());
    expect(save).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledTimes(2);
    expect(present.mock.calls[0]![2]!.authentication.protocol).toBe('legacy-login');
  });

  test('a non-web transport needs an explicit attested origin resolver', async () => {
    const request = authRequest();
    request.origin = { kind: 'local', identifier: 'local-app' };
    const strict = await fixture(true);
    await expect(strict.core.handle(request)).rejects.toMatchObject({ code: 'invalid_request' });
    const mapped = await fixture(true, { authentication: { originFor: async () => 'https://example.com' } });
    mapped.approval.decide = consent;
    await expect(mapped.core.handle(request)).resolves.toHaveProperty('sig');
  });
  test('legacy refusal does not create a blanket relay-authentication denial', async () => {
    const { core, approval, permissions } = await fixture(false, { authentication: { legacyLoginOrigins: ['https://example.com'] } });
    approval.decide = async () => ({ allow: false, remember: true });
    const save = vi.spyOn(permissions, 'save');
    await expect(core.handle(authRequest(22242, [['domain', 'example.com'], ['challenge', 'challenge']]))).rejects.toMatchObject({ code: 'rejected' });
    expect(save).not.toHaveBeenCalled();
  });

  test('revokeOrigin after approval stops authentication before key use', async () => {
    let checks = 0;
    const { core, vault, approval } = await fixture(true, { authentication: { assertAllowed: async () => {
      if (++checks === 2) core.revokeOrigin('https://example.com');
    } } });
    approval.decide = consent;
    const key = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'rejected' });
    expect(key).not.toHaveBeenCalled();
  });

  test('a signed result is not released after the host locks during revalidation', async () => {
    let checks = 0;
    const { core, vault, approval } = await fixture(true, { authentication: { assertAllowed: async () => {
      if (++checks === 3) vault.lock();
    } } });
    approval.decide = consent;
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'vault_locked' });
  });

  test('authentication expiry during the final async policy check drops the signature', async () => {
    let now = Date.now(), checks = 0;
    const { core, approval } = await fixture(true, { now: () => now, authentication: { assertAllowed: async () => {
      if (++checks === 3) now += 120_000;
    } } });
    approval.decide = consent;
    await expect(core.handle(authRequest())).rejects.toMatchObject({ code: 'invalid_request' });
  });

});
