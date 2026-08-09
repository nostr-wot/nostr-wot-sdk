import { describe, it, expect } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  derivePqKeys, kemInfo, dsaInfo, popMessage, signPop, verifyPop,
  encapsulate, decapsulate, hybridKey, buildAttestationTags, parseAttestation,
  attestationFilter, toBase64, fromBase64,
  PQC_KIND, KEM_PUBLIC_KEY_BYTES, DSA_PUBLIC_KEY_BYTES, ALG_KEM, ALG_DSA,
} from '../src/index.js';

// The 24-word test mnemonic published in NIP-06, and the key it must produce.
const M =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';
const NIP06_PRIVKEY = 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add';
const PUBKEY = 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573';

const seed = () => mnemonicToSeedSync(M);

describe('derivation', () => {
  it('the seed still produces the secp256k1 key NIP-06 publishes', () => {
    const hd = HDKey.fromMasterSeed(seed()).derive("m/44'/1237'/0'/0/0");
    expect(bytesToHex(hd.privateKey!)).toBe(NIP06_PRIVKEY);
  });

  it('profile strings are stable', () => {
    expect(kemInfo(0)).toBe('nip-pqc/v1/ml-kem-1024/0');
    expect(dsaInfo(0)).toBe('nip-pqc/v1/ml-dsa-87/0');
  });

  it('matches the published test vectors', () => {
    const { kem, dsa } = derivePqKeys(seed(), 0);
    expect(kem.publicKey.length).toBe(KEM_PUBLIC_KEY_BYTES);
    expect(dsa.publicKey.length).toBe(DSA_PUBLIC_KEY_BYTES);
    expect(bytesToHex(sha256(kem.publicKey))).toBe(
      'f15e1a31adc3198a3e09f1d473aa0f2cd3e28392b77f1e350468bae15dfa251b',
    );
    expect(bytesToHex(sha256(dsa.publicKey))).toBe(
      '6912f6f1dd8f8e6c1d9e7d349d75ef1b582ccf2aa95636bf2445b0e22be18e16',
    );
  });

  it('is deterministic', () => {
    expect(derivePqKeys(seed(), 0).kem.publicKey).toEqual(derivePqKeys(seed(), 0).kem.publicKey);
  });

  it('different accounts give different keys', () => {
    expect(derivePqKeys(seed(), 0).kem.publicKey).not.toEqual(
      derivePqKeys(seed(), 1).kem.publicKey,
    );
  });

  it('deriving from the secp256k1 private key gives different keys', () => {
    // The tripwire: if anyone "simplifies" this to take the private key, the whole
    // scheme becomes circular and this test should stop them.
    const priv = HDKey.fromMasterSeed(seed()).derive("m/44'/1237'/0'/0/0").privateKey!;
    expect(derivePqKeys(seed(), 0).kem.publicKey).not.toEqual(
      derivePqKeys(priv, 0).kem.publicKey,
    );
  });

  it('rejects bad input', () => {
    expect(() => derivePqKeys(new Uint8Array(0))).toThrow(/Invalid seed/);
    expect(() => derivePqKeys(seed(), -1)).toThrow(/Invalid account index/);
  });
});

describe('base64 helpers', () => {
  it('round-trip arbitrary bytes', () => {
    const bytes = new Uint8Array(512).map((_, i) => (i * 7) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe('KEM', () => {
  it('round-trips a shared secret', () => {
    const { kem } = derivePqKeys(seed(), 0);
    const { cipherText, sharedSecret } = encapsulate(kem.publicKey);
    expect(decapsulate(cipherText, kem.secretKey)).toEqual(sharedSecret);
    expect(sharedSecret.length).toBe(32);
  });

  it('rejects a malformed public key', () => {
    expect(() => encapsulate(new Uint8Array(10))).toThrow(/Invalid ML-KEM public key length/);
  });
});

describe('hybridKey', () => {
  it('depends on both inputs', () => {
    const ss = new Uint8Array(32).fill(1);
    const ck = new Uint8Array(32).fill(2);
    const base = hybridKey(ss, ck);
    expect(base.length).toBe(32);
    expect(hybridKey(new Uint8Array(32).fill(9), ck)).not.toEqual(base);
    expect(hybridKey(ss, new Uint8Array(32).fill(9))).not.toEqual(base);
  });

  it('is not a plain concatenation of either input', () => {
    const ss = new Uint8Array(32).fill(1);
    const ck = new Uint8Array(32).fill(2);
    expect(hybridKey(ss, ck)).not.toEqual(ss);
    expect(hybridKey(ss, ck)).not.toEqual(ck);
  });
});

function validEvent(origin: 'derived' | 'independent' = 'derived') {
  const { kem, dsa } = derivePqKeys(seed(), 0);
  return {
    pubkey: PUBKEY,
    kind: PQC_KIND,
    tags: buildAttestationTags({
      pubkey: PUBKEY,
      kem: kem.publicKey,
      dsa: dsa.publicKey,
      origin,
      dsaSecretKey: dsa.secretKey,
    }),
  };
}

describe('attestation', () => {
  it('accepts an attestation it built itself', () => {
    const r = parseAttestation(validEvent());
    expect(r.problems).toEqual([]);
    expect(r.usable).toBe(true);
    expect(r.popValid).toBe(true);
    expect(r.origin).toBe('derived');
    expect(r.seedStrength).toBe('256');
    expect(r.kem?.length).toBe(KEM_PUBLIC_KEY_BYTES);
  });

  it('omits seed_strength for independent keys', () => {
    const r = parseAttestation(validEvent('independent'));
    expect(r.origin).toBe('independent');
    expect(r.seedStrength).toBeNull();
    expect(r.usable).toBe(true);
  });

  it('rejects a tampered KEM key', () => {
    const ev = validEvent();
    const other = derivePqKeys(seed(), 1).kem.publicKey;
    ev.tags = ev.tags.map((t) =>
      t[0] === 'alg' && t[1] === ALG_KEM ? ['alg', ALG_KEM, toBase64(other)] : t,
    );
    const r = parseAttestation(ev);
    expect(r.popValid).toBe(false);
    expect(r.usable).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('popFailed');
  });

  it('rejects a pop signed by a different key', () => {
    const ev = validEvent();
    const attacker = derivePqKeys(seed(), 99);
    const kemB64 = ev.tags.find((t) => t[1] === ALG_KEM)![2]!;
    const dsaB64 = ev.tags.find((t) => t[1] === ALG_DSA)![2]!;
    const forged = signPop(popMessage(PUBKEY, kemB64, dsaB64), attacker.dsa.secretKey);
    ev.tags = ev.tags.map((t) => (t[0] === 'pop' ? ['pop', ALG_DSA, toBase64(forged)] : t));
    expect(parseAttestation(ev).popValid).toBe(false);
  });

  it('rejects an attestation claimed for a different npub', () => {
    const ev = validEvent();
    ev.pubkey = 'aa'.repeat(32);
    expect(parseAttestation(ev).popValid).toBe(false);
  });

  it('flags a wrong-length key', () => {
    const ev = validEvent();
    ev.tags = ev.tags.map((t) =>
      t[0] === 'alg' && t[1] === ALG_KEM ? ['alg', ALG_KEM, toBase64(new Uint8Array(100))] : t,
    );
    const r = parseAttestation(ev);
    const codes = r.problems.map((p) => p.code);
    expect(codes).toContain('keyLength');
    expect(codes).toContain('noKem');
    expect(r.usable).toBe(false);
  });

  it('flags a derived attestation with a weak seed', () => {
    const ev = validEvent();
    ev.tags = ev.tags.map((t) => (t[0] === 'seed_strength' ? ['seed_strength', '128'] : t));
    const r = parseAttestation(ev);
    expect(r.problems.map((p) => p.code)).toContain('derivedWeakSeed');
    expect(r.usable).toBe(false);
  });

  it('flags a missing proof of possession', () => {
    const ev = validEvent();
    ev.tags = ev.tags.filter((t) => t[0] !== 'pop');
    const r = parseAttestation(ev);
    expect(r.problems.map((p) => p.code)).toContain('missingPop');
    expect(r.popValid).toBeNull();
  });

  it('ignores unknown algorithms rather than failing', () => {
    const ev = validEvent();
    ev.tags = [...ev.tags, ['alg', 'sphincs-shake-256s', toBase64(new Uint8Array(64))]];
    expect(parseAttestation(ev).usable).toBe(true);
  });

  it('reports an empty attestation', () => {
    const r = parseAttestation({ pubkey: PUBKEY, kind: PQC_KIND, tags: [] });
    const codes = r.problems.map((p) => p.code);
    expect(codes).toContain('noAlgTags');
    expect(codes).toContain('noKem');
    expect(r.usable).toBe(false);
  });
});

describe('attestationFilter', () => {
  it('targets the right kind', () => {
    expect(attestationFilter([PUBKEY])).toEqual({ kinds: [PQC_KIND], authors: [PUBKEY] });
  });
});
