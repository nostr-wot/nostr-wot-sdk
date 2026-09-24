/**
 * The compile-time half of the vault's contract.
 *
 * `withPrivkey(undefined, fn)` meant "whatever account is active now", which is precisely
 * the substitution the signing pipeline exists to prevent: a request resolved for one account
 * must be signed by that account's key, not by whichever one the user has since moved to.
 * Every scoped accessor names its account at the type level; only `withCacheKey` has no
 * account to name.
 */
import { expectTypeOf, test } from 'vitest';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault } from '../src/index.js';

test('every scoped accessor names its account', () => {
  const vault = new Vault({ store: new MemoryStore() });
  // @ts-expect-error the account id is required: there is no "the active one"
  void vault.withPrivkey(undefined, async () => 0);
  // @ts-expect-error the account id is required
  void vault.withMnemonic(undefined, async () => 0);
  // @ts-expect-error the account id is required
  void vault.withImportedPqKeys(undefined, async () => 0);
  // @ts-expect-error the account id is required
  void vault.withRemoteSignerCredentials(undefined, async () => 0);
  expectTypeOf(vault.withPrivkey).parameter(0).toEqualTypeOf<string>();
});

test('the vault owns the clock the rest of the system reads', () => {
  const vault = new Vault({ store: new MemoryStore() });
  expectTypeOf(vault.now).toEqualTypeOf<() => number>();
});
