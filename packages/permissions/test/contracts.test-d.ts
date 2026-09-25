/**
 * The compile-time half of the store's contract: every read and write names its account.
 *
 * The runtime fails closed on a missing account id in per-account mode, and that was found
 * to be the wrong half to fix alone. A transport that forgets the parameter compiles, works
 * in global mode (the default), and in per-account mode prompts forever while every remembered
 * approval reads as an internal error. Required at the type level, forgetting is a compile
 * error, which is the only place it is cheap.
 */
import { expectTypeOf, test } from 'vitest';
import { MemoryStore } from '@nostr-wot/storage';
import { Permissions, consultedKeys, permissionKey, resolve, resolveDetailed } from '../src/index.js';

test('check, save, saveDirect, getAll, getForOrigin and clear all require an account id', () => {
  const permissions = new Permissions(new MemoryStore());

  // @ts-expect-error the account id is required
  void permissions.check('a.com', 'signEvent', 1);
  // @ts-expect-error the account id is required
  void permissions.check('a.com', 'getPublicKey');
  void permissions.check('a.com', 'getPublicKey', undefined, 'acct');

  // @ts-expect-error the account id is required
  void permissions.save('a.com', 'signEvent', 1, 'allow');
  // @ts-expect-error the account id is required
  void permissions.saveDirect('a.com', 'signEvent:1', 'allow');
  // @ts-expect-error the account id is required
  void permissions.getAll();
  // @ts-expect-error the account id is required
  void permissions.getForOrigin('a.com');
  // @ts-expect-error the account id is required
  void permissions.clear();
  // @ts-expect-error the account id is required
  void permissions.clear('a.com');
  void permissions.clear(undefined, 'acct');

  expectTypeOf(permissions.check).parameter(3).toEqualTypeOf<string>();
});

test('check needs the kind exactly when the method is signEvent', () => {
  const permissions = new Permissions(new MemoryStore());
  void permissions.check('a.com', 'signEvent', 1, 'acct');
  void permissions.check('a.com', 'getPublicKey', undefined, 'acct');
  // @ts-expect-error a signEvent check without the kind reads the wrong level
  void permissions.check('a.com', 'signEvent', undefined, 'acct');
  // @ts-expect-error a kind on anything but signEvent is a caller confusion
  void permissions.check('a.com', 'nip04Decrypt', 4, 'acct');
  // A method that is only known at runtime has to be narrowed first.
  const method = 'signEvent' as string;
  // @ts-expect-error not narrowed
  void permissions.check('a.com', method, 1, 'acct');
  if (method === 'signEvent') void permissions.check('a.com', method, 1, 'acct');
  expectTypeOf(permissions.save).parameter(4).toEqualTypeOf<string>();
  expectTypeOf(permissions.saveDirect).parameter(3).toEqualTypeOf<string>();
  expectTypeOf(permissions.getAll).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(permissions.getForOrigin).parameter(1).toEqualTypeOf<string>();
  expectTypeOf(permissions.clear).parameter(1).toEqualTypeOf<string>();
});

test('the exported cascade functions need the kind exactly when the method is signEvent', () => {
  const bucket = { '*': 'allow' } as const;
  void resolve(bucket, 'signEvent', 1);
  void resolve(bucket, 'getPublicKey');
  void resolveDetailed(bucket, 'nip04Decrypt');
  void consultedKeys('signEvent', 7);
  void permissionKey('signEvent', 1);
  void permissionKey('signEvent', null); // the blanket key, for a write
  void permissionKey('getPublicKey');
  // @ts-expect-error a signEvent read needs its kind
  void resolve(bucket, 'signEvent');
  // @ts-expect-error null is not a kind to read by
  void resolve(bucket, 'signEvent', null);
  // @ts-expect-error a signEvent read needs its kind
  void resolveDetailed(bucket, 'signEvent');
  // @ts-expect-error a signEvent read needs its kind
  void consultedKeys('signEvent');
  // @ts-expect-error a kind on anything but signEvent is a caller confusion
  void resolve(bucket, 'getPublicKey', 1);
  // @ts-expect-error the blanket key is a deliberate null, never an omission
  void permissionKey('signEvent');
  const permissions = new Permissions(new MemoryStore());
  // @ts-expect-error null is not a kind to read by
  void permissions.check('a.com', 'signEvent', null, 'acct');
  // A write may name the blanket key with null; a read may not.
  void permissions.save('a.com', 'signEvent', null, 'allow', 'acct');
  void permissions.save('a.com', 'getPublicKey', undefined, 'allow', 'acct');
});
