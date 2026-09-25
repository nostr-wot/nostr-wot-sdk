/**
 * The seed is the whole identity. It exists only to be expanded into the post-quantum key
 * seeds, and the expansion is over, and the seed zeroed, before the callback runs. Observed
 * through a module mock of `mnemonicToSeed`, which is why this lives in its own file.
 */
import { describe, test, expect, vi } from 'vitest';
import type { Account } from '@nostr-wot/accounts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { withPqKeys } from '../src/index.js';
import { account, fixture } from './harness.js';

const seeds: Uint8Array[] = [];

vi.mock('@nostr-wot/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nostr-wot/accounts')>();
  return {
    ...actual,
    mnemonicToSeed: (mnemonic: string, passphrase?: string) => {
      const seed = actual.mnemonicToSeed(mnemonic, passphrase);
      seeds.push(seed);
      return seed;
    },
  };
});

const M24 =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';

describe('withPqKeys and the seed', () => {
  test('the seed is zeroed after derivation, before the callback runs', async () => {
    const { deriveFromMnemonic } = await vi.importActual<typeof import('@nostr-wot/accounts')>('@nostr-wot/accounts');
    const derived = deriveFromMnemonic(M24, 0);
    const acct: Account = account('acct_seed', bytesToHex(derived.privkey), { type: 'generated', mnemonic: M24, derivationIndex: 0 });
    const { vault, identity } = await fixture(true, { accounts: [acct] });
    const active = (await identity.getActiveAccount())!;
    seeds.length = 0;
    let observed: number[] | null = null;
    await withPqKeys(vault, active, async () => {
      observed = Array.from(seeds[0] ?? []);
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.length).toBe(64);
    expect(observed).toEqual(new Array<number>(64).fill(0));
  });
});
