/**
 * The account selector, as the extension derives it.
 *
 * The extension's `derivePqKeys(seed, acct.derivationPath ?? acct.derivationIndex ?? 0)`
 * hands a BIP-32 path when the account was restored at one. A standard NIP-06 path keeps
 * the published numeric selector, so keys derived before paths were stored are the same
 * keys; a custom path gets its own namespace, `path/<canonical path>`, and is never
 * collapsed to its last child index, because two custom paths sharing a last index would
 * otherwise share post-quantum keys. Anything that is not a canonical path is refused,
 * loudly, rather than derived under a spelling no other implementation would produce.
 */
import { describe, it, expect } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { derivePqKeys, kemInfo, dsaInfo } from '../src/index.js';

const M =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';
const seed = () => mnemonicToSeedSync(M);

describe('derivation by path', () => {
  it('a standard NIP-06 path selects the same keys as its account index', () => {
    expect(kemInfo("m/44'/1237'/0'/0/5")).toBe(kemInfo(5));
    expect(dsaInfo("m/44'/1237'/0'/0/5")).toBe(dsaInfo(5));
    expect(derivePqKeys(seed(), "m/44'/1237'/0'/0/5").kem.publicKey).toEqual(
      derivePqKeys(seed(), 5).kem.publicKey,
    );
  });

  it('a custom path gets its own namespace and is not collapsed to its last index', () => {
    expect(kemInfo("m/44'/1237'/8'/0/2")).toBe("nip-pqc/v1/ml-kem-1024/path/m/44'/1237'/8'/0/2");
    expect(dsaInfo("m/44'/1237'/8'/0/2")).toBe("nip-pqc/v1/ml-dsa-87/path/m/44'/1237'/8'/0/2");
    const custom = derivePqKeys(seed(), "m/44'/1237'/8'/0/2");
    expect(custom.kem.publicKey).not.toEqual(derivePqKeys(seed(), 2).kem.publicKey);
    expect(custom.kem.publicKey).not.toEqual(derivePqKeys(seed(), "m/44'/1237'/9'/0/2").kem.publicKey);
  });

  it('refuses a path that is not canonical, so a spelling no other implementation produces is never derived', () => {
    for (const path of ["m/44'/1237'/0'/0/2h", "m/44'/1237'/0'/0/2H", " m/44'/1237'/0'/0/2", 'm/', "44'/1237'/0'/0/2", "m/44'/x'/0'/0/2", 'm/2147483648', '']) {
      expect(() => derivePqKeys(seed(), path), path).toThrow(/Invalid derivation path/);
    }
  });

  it('the numeric selector is unchanged', () => {
    expect(kemInfo(0)).toBe('nip-pqc/v1/ml-kem-1024/0');
    expect(kemInfo()).toBe('nip-pqc/v1/ml-kem-1024/0');
  });
});
