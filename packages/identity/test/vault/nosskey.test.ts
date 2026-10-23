import { describe, expect, it } from 'vitest';
import { getPublicKey, nip44 } from 'nostr-tools';
import { parseNosskeyAccount, nosskeyPrfInput, recoverNosskeyAccount } from '../../src/vault/nosskey.js';
const prf = new Uint8Array(32).fill(66);
const key = new Uint8Array(32).fill(1);
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const direct = { credentialId: '01020304', pubkey: getPublicKey(prf), salt: '6e6f7374722d70776b' };
const wrapped = () => ({ ...direct, pubkey: getPublicKey(key), salt: '6e6f7374722d70776b2d77726170', wrapped: { v: 1, alg: 'nip44-v2', payload: nip44.v2.encrypt(hex(key), nip44.v2.utils.getConversationKey(prf, getPublicKey(prf)), new Uint8Array(32).fill(3)) } });
describe('Nosskey metadata recovery', () => {
  it('uses the original direct PRF output without HKDF', () => {
    const account = parseNosskeyAccount(JSON.stringify(direct));
    expect(new TextDecoder().decode(nosskeyPrfInput(account))).toBe('nostr-pwk');
    const secret = recoverNosskeyAccount(account, prf);
    expect(secret).toEqual(prf);
    expect(secret).not.toBe(prf);
  });
  it('opens NIP-44 self-wrapped hex and preserves the identity', () => {
    const account = parseNosskeyAccount(JSON.stringify(wrapped()));
    expect(new TextDecoder().decode(nosskeyPrfInput(account))).toBe('nostr-pwk-wrap');
    expect(recoverNosskeyAccount(account, prf)).toEqual(key);
  });
  it('refuses mismatched public keys and wrong PRF', () => {
    expect(() => recoverNosskeyAccount({...direct, pubkey:getPublicKey(key)},prf)).toThrow();
    expect(() => recoverNosskeyAccount(wrapped(),new Uint8Array(32).fill(9))).toThrow();
    expect(() => recoverNosskeyAccount({...wrapped(),pubkey:getPublicKey(prf)},prf)).toThrow();
  });
  it.each([
    {...direct, salt:'00'}, {...direct, salt:'6e6f7374722d70776b2d77726170'},
    {...wrapped(), salt:direct.salt}, {...direct, wrapped:null},
    {...wrapped(), wrapped:{v:2,alg:'nip44-v2',payload:'abc'}},
    {...direct, credentialId:'xyz'}, {...direct, pubkey:'00'.repeat(32)},
  ])('rejects invalid or inconsistent metadata without falling back', value => {
    expect(() => parseNosskeyAccount(JSON.stringify(value))).toThrow();
  });
  it('accepts the historical direct salt label only as the original SDK does', () => {
    expect(parseNosskeyAccount(JSON.stringify({...direct,salt:'6e6f7374722d6b6579'})).salt).toBe(direct.salt);
  });
  it('bounds inputs and does not consume caller-owned PRF', () => {
    expect(()=>parseNosskeyAccount(' '.repeat(100_000))).toThrow();
    expect(()=>recoverNosskeyAccount(direct,new Uint8Array(31))).toThrow();
    const copy=prf.slice(); recoverNosskeyAccount(wrapped(),copy); expect(copy).toEqual(prf);
  });
});
