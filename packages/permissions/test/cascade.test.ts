/**
 * The pure half of the package: how a wire method becomes a permission key, and how a
 * bucket of stored decisions becomes one answer.
 *
 * This is the security critical part, so it is tested exhaustively and without storage.
 * The property under test is that `deny` wins from any consulted level: a kind-specific
 * `allow` must never override a method-level or wildcard `deny`, and a broad `*` allow
 * must never bypass a narrower deny. Combinations that look redundant are still listed,
 * because a regression would most likely show up in exactly one of them.
 */
import { describe, test, expect } from 'vitest';
import {
  permissionKey,
  resolve,
  consultedKeys,
  DM_SIGN_KINDS,
  type PermissionBucket,
  type PermissionDecision,
} from '../src/index.js';

describe('permissionKey', () => {
  test('signEvent is keyed per kind, and DM kinds collapse into sendMessages', () => {
    expect(permissionKey('signEvent', 1)).toBe('signEvent:1');
    expect(permissionKey('signEvent', 4)).toBe('sendMessages');
    expect(permissionKey('signEvent', 1059)).toBe('sendMessages');
    expect(permissionKey('nip44Encrypt')).toBe('sendMessages');
    expect(permissionKey('nip04Decrypt')).toBe('readMessages');
    expect(permissionKey('getPublicKey')).toBe('getPublicKey');
  });

  test('every DM sign kind collapses, and its neighbours do not', () => {
    expect([...DM_SIGN_KINDS].sort((a, b) => a - b)).toEqual([4, 13, 14, 1059]);
    for (const kind of DM_SIGN_KINDS) {
      expect(permissionKey('signEvent', kind)).toBe('sendMessages');
    }
    for (const kind of [0, 3, 5, 12, 15, 1058, 1060, 30023]) {
      expect(permissionKey('signEvent', kind)).toBe(`signEvent:${kind}`);
    }
  });

  test('both encrypt methods share sendMessages and both decrypt methods share readMessages', () => {
    expect(permissionKey('nip04Encrypt')).toBe('sendMessages');
    expect(permissionKey('nip44Encrypt')).toBe('sendMessages');
    expect(permissionKey('nip04Decrypt')).toBe('readMessages');
    expect(permissionKey('nip44Decrypt')).toBe('readMessages');
  });

  test('webln methods pass through unchanged', () => {
    expect(permissionKey('webln_sendPayment')).toBe('webln_sendPayment');
    expect(permissionKey('webln_getBalance', 1)).toBe('webln_getBalance');
  });

  test('signEvent without a kind stays the bare method name', () => {
    expect(permissionKey('signEvent')).toBe('signEvent');
    expect(permissionKey('signEvent', null)).toBe('signEvent');
  });
});

describe('consultedKeys', () => {
  test('a per-kind method consults kind, then method, then wildcard', () => {
    expect(consultedKeys('signEvent', 1)).toEqual(['signEvent:1', 'signEvent', '*']);
  });

  test('a DM kind consults sendMessages, then signEvent, then wildcard', () => {
    expect(consultedKeys('signEvent', 4)).toEqual(['sendMessages', 'signEvent', '*']);
  });

  test('a method whose key equals its name is not consulted twice', () => {
    expect(consultedKeys('getPublicKey')).toEqual(['getPublicKey', '*']);
    expect(consultedKeys('webln_sendPayment')).toEqual(['webln_sendPayment', '*']);
  });
});

describe('resolve', () => {
  test('an undefined bucket asks', () => {
    expect(resolve({}, 'signEvent', 1)).toBe('ask');
    expect(resolve({}, 'getPublicKey')).toBe('ask');
    expect(resolve({ 'signEvent:2': 'allow' }, 'signEvent', 1)).toBe('ask');
  });

  test('the most specific defined value wins when nothing denies', () => {
    expect(resolve({ '*': 'allow' }, 'signEvent', 1)).toBe('allow');
    expect(resolve({ '*': 'allow', signEvent: 'ask' }, 'signEvent', 1)).toBe('ask');
    expect(resolve({ '*': 'ask', 'signEvent:1': 'allow' }, 'signEvent', 1)).toBe('allow');
  });

  test('deny wins over any allow at any level', () => {
    expect(resolve({ 'signEvent:1': 'allow', signEvent: 'deny' }, 'signEvent', 1)).toBe('deny');
    expect(resolve({ 'signEvent:1': 'allow', '*': 'deny' }, 'signEvent', 1)).toBe('deny');
    expect(resolve({ signEvent: 'allow', '*': 'deny' }, 'signEvent', 1)).toBe('deny');
  });

  /**
   * Every allow/deny/ask/unset value at every consulted level. 4^3 = 64 cases, each
   * checked against the rule stated independently of the implementation: deny anywhere
   * means deny, otherwise the first defined value in kind > method > wildcard order,
   * otherwise ask.
   */
  test('every combination of the three levels obeys deny-wins, then most-specific', () => {
    const values: (PermissionDecision | undefined)[] = ['allow', 'deny', 'ask', undefined];
    let checked = 0;
    for (const kindValue of values) {
      for (const methodValue of values) {
        for (const wildcardValue of values) {
          const bucket: PermissionBucket = {};
          if (kindValue) bucket['signEvent:1'] = kindValue;
          if (methodValue) bucket['signEvent'] = methodValue;
          if (wildcardValue) bucket['*'] = wildcardValue;

          const levels = [kindValue, methodValue, wildcardValue];
          const expected: PermissionDecision = levels.includes('deny')
            ? 'deny'
            : (levels.find((value) => value !== undefined) ?? 'ask');

          expect(resolve(bucket, 'signEvent', 1), JSON.stringify(bucket)).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(64);
  });

  test('a deny on the DM group denies both the encrypt and the matching signEvent', () => {
    const bucket: PermissionBucket = { sendMessages: 'deny', 'signEvent:1': 'allow' };
    expect(resolve(bucket, 'signEvent', 4)).toBe('deny');
    expect(resolve(bucket, 'signEvent', 1059)).toBe('deny');
    expect(resolve(bucket, 'nip04Encrypt')).toBe('deny');
    expect(resolve(bucket, 'nip44Encrypt')).toBe('deny');
    expect(resolve(bucket, 'signEvent', 1)).toBe('allow');
  });

  test('a method-level deny on signEvent still denies a DM kind', () => {
    expect(resolve({ sendMessages: 'allow', signEvent: 'deny' }, 'signEvent', 4)).toBe('deny');
    // ...but it does not reach the encrypt method, which never consults signEvent.
    expect(resolve({ sendMessages: 'allow', signEvent: 'deny' }, 'nip04Encrypt')).toBe('allow');
  });

  test('a deny for one kind does not leak into another', () => {
    const bucket: PermissionBucket = { 'signEvent:1': 'deny', 'signEvent:0': 'allow' };
    expect(resolve(bucket, 'signEvent', 1)).toBe('deny');
    expect(resolve(bucket, 'signEvent', 0)).toBe('allow');
    expect(resolve(bucket, 'signEvent', 7)).toBe('ask');
  });

  test('an unknown key in the bucket changes nothing', () => {
    expect(resolve({ nonsense: 'deny' }, 'signEvent', 1)).toBe('ask');
  });
});
