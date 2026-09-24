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
import { Permissions } from '../src/index.js';

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
  expectTypeOf(permissions.save).parameter(4).toEqualTypeOf<string>();
  expectTypeOf(permissions.saveDirect).parameter(3).toEqualTypeOf<string>();
  expectTypeOf(permissions.getAll).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(permissions.getForOrigin).parameter(1).toEqualTypeOf<string>();
  expectTypeOf(permissions.clear).parameter(1).toEqualTypeOf<string>();
});
