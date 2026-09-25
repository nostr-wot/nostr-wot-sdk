/**
 * Post-quantum support in the pipeline, held to the extension's behaviour.
 *
 * Three things are under test. The key scope: post-quantum secrets are key material, so
 * every path to them goes through `withPqKeys`, which resolves them exactly as the
 * extension's `activePqKeys` does (imported keys first, then a 24-word seed at the
 * account's derivation path), zeroes its copies on every path and voids a result computed
 * under a session that moved. Decrypt routing: `nip44Decrypt` reads the self-describing
 * envelope and takes the hybrid path for a post-quantum payload, the existing path for a
 * classic one, and fails as `operation_failed` for anything else, never silently. And the
 * encrypt policy, which is the extension's and is opt-in: hybrid only when the caller
 * passes `opts: { scheme: 'pq', recipientKemKey }`, never inferred from a relay lookup.
 *
 * The attestation is a signing request like any other: `signPqAttestation` runs the same
 * pipeline under the `signEvent` rule for kind 10203, and a stored deny holds.
 */
import { describe, test, expect, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Account } from '@nostr-wot/accounts';
import { deriveFromMnemonic, mnemonicToSeed } from '@nostr-wot/accounts';
import { PrivateKeySigner } from '@nostr-wot/signers';
import {
  ALG_DSA,
  ALG_KEM,
  buildAttestationTags,
  decryptPq,
  derivePqKeys,
  encryptPq,
  fromBase64,
  isPqEnvelope,
  parseAttestation,
  toBase64,
  type PqKeys,
} from '@nostr-wot/pq';
import {
  SignerError,
  PQC_KIND,
  PQ_SEED_WORD_COUNT,
  verifyPqAttestation,
  withPqKeys,
  type EventTemplateInput,
  type PqKeyScope,
  type RemoteSignerPort,
} from '../src/index.js';
import { account, fixture, req, nextId, PASSWORD, PRIVKEY_2, PUBKEY_2 } from './harness.js';

// ── Identities ──

/** The 24-word mnemonic NIP-06 publishes, and the identity it derives at index 0. */
const M24 =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';
/** A valid 12-word phrase: 128 bits, which the extension refuses for post-quantum keys. */
const M12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function seededAccount(id: string, mnemonic: string, index = 0, extra: Partial<Account> = {}): Account {
  const derived = deriveFromMnemonic(mnemonic, index);
  return account(id, bytesToHex(derived.privkey), {
    type: 'generated',
    mnemonic,
    derivationIndex: index,
    derivationPath: derived.path,
    ...extra,
  });
}

/** An externally generated pair, in the shape the vault stores it. */
function importedPair(): { keys: PqKeys; stored: NonNullable<Account['pqKeys']> } {
  const keys = derivePqKeys(randomBytes(64), 0);
  return {
    keys,
    stored: {
      profile: 'nip-pqc/v1',
      kem: { public: toBase64(keys.kem.publicKey), secret: toBase64(keys.kem.secretKey) },
      dsa: { public: toBase64(keys.dsa.publicKey), secret: toBase64(keys.dsa.secretKey) },
      importedAt: 1,
    },
  };
}

/** The keys the extension would derive for this account: what every derived path must equal. */
function expectedKeys(mnemonic: string, selector: number | string): PqKeys {
  const seed = mnemonicToSeed(mnemonic);
  try {
    return derivePqKeys(seed, selector);
  } finally {
    seed.fill(0);
  }
}

/** Someone else, with a conversation key to our account, as a sender or a recipient. */
function peer(ourPubkey: string) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, pk, conversationKey: nip44.v2.utils.getConversationKey(sk, ourPubkey) };
}

/** A post-quantum payload for `recipientPubkey`, as a sender who holds their attestation builds it. */
function hybridPayload(plaintext: string, from: ReturnType<typeof peer>, recipientPubkey: string, recipientKem: Uint8Array): string {
  return encryptPq(plaintext, recipientKem, from.conversationKey, { sender: from.pk, recipient: recipientPubkey });
}

const zeros = (length: number) => new Array<number>(length).fill(0);

// ── The key scope ──

describe('withPqKeys resolves the account\'s post-quantum keys as the extension does', () => {
  test('a 24-word account derives at its NIP-06 index, and the keys are the extension\'s', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { vault, identity } = await fixture(true, { accounts: [acct] });
    const active = (await identity.getActiveAccount())!;
    const expected = expectedKeys(M24, 0);
    const seen = await withPqKeys(vault, active, async (scope: PqKeyScope) => ({
      source: scope.source,
      kem: toBase64(scope.keys.kem.publicKey),
      dsa: toBase64(scope.keys.dsa.publicKey),
    }));
    expect(seen).toEqual({
      source: 'derived',
      kem: toBase64(expected.kem.publicKey),
      dsa: toBase64(expected.dsa.publicKey),
    });
  });

  test('an account restored at a custom path derives under that path, never its last index', async () => {
    const path = "m/44'/1237'/8'/0/2";
    const derived = deriveFromMnemonic(M24, 0);
    const acct = account('acct_path', bytesToHex(derived.privkey), { type: 'generated', mnemonic: M24, derivationPath: path });
    const { vault, identity } = await fixture(true, { accounts: [acct] });
    const active = (await identity.getActiveAccount())!;
    const kem = await withPqKeys(vault, active, async (scope) => toBase64(scope.keys.kem.publicKey));
    expect(kem).toBe(toBase64(expectedKeys(M24, path).kem.publicKey));
    expect(kem).not.toBe(toBase64(expectedKeys(M24, 2).kem.publicKey));
  });

  test('a sub-account derives at its own index, so two accounts on one seed do not share keys', async () => {
    const first = seededAccount('acct_0', M24, 0);
    const second = seededAccount('acct_3', M24, 3);
    const { vault, identity } = await fixture(true, { accounts: [first, second] });
    await vault.setActiveAccountId('acct_3');
    const active = (await identity.getActiveAccount())!;
    expect(active.id).toBe('acct_3');
    const kem = await withPqKeys(vault, active, async (scope) => toBase64(scope.keys.kem.publicKey));
    expect(kem).toBe(toBase64(expectedKeys(M24, 3).kem.publicKey));
    expect(kem).not.toBe(toBase64(expectedKeys(M24, 0).kem.publicKey));
  });

  test('imported keys win, because they are what the published attestation advertises', async () => {
    const { keys, stored } = importedPair();
    const acct = seededAccount('acct_both', M24, 0, { pqKeys: stored });
    const { vault, identity } = await fixture(true, { accounts: [acct] });
    const active = (await identity.getActiveAccount())!;
    const seen = await withPqKeys(vault, active, async (scope) => ({
      source: scope.source,
      kem: toBase64(scope.keys.kem.publicKey),
      kemSecret: toBase64(scope.keys.kem.secretKey),
      dsa: toBase64(scope.keys.dsa.publicKey),
    }));
    expect(seen).toEqual({
      source: 'imported',
      kem: toBase64(keys.kem.publicKey),
      kemSecret: toBase64(keys.kem.secretKey),
      dsa: toBase64(keys.dsa.publicKey),
    });
    expect(seen.kem).not.toBe(toBase64(expectedKeys(M24, 0).kem.publicKey));
  });

  test('an account with no seed phrase is refused with the extension\'s reason', async () => {
    const { vault, identity } = await fixture(true, { accounts: [account('acct_nsec', PRIVKEY_2)] });
    const active = (await identity.getActiveAccount())!;
    const error = await withPqKeys(vault, active, async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignerError);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no seed phrase, so it cannot use post-quantum keys');
  });

  test('a 12-word account is refused rather than handed a weak key that looks strong', async () => {
    const { vault, identity } = await fixture(true, { accounts: [seededAccount('acct_12', M12)] });
    const active = (await identity.getActiveAccount())!;
    const error = await withPqKeys(vault, active, async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignerError);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('Post-quantum keys require a 24-word seed phrase');
    expect(PQ_SEED_WORD_COUNT).toBe(24);
  });

  test('a 12-word account with imported keys uses them: the import exists for exactly this account', async () => {
    const { keys, stored } = importedPair();
    const { vault, identity } = await fixture(true, { accounts: [seededAccount('acct_12i', M12, 0, { pqKeys: stored })] });
    const active = (await identity.getActiveAccount())!;
    const kem = await withPqKeys(vault, active, async (scope) => toBase64(scope.keys.kem.publicKey));
    expect(kem).toBe(toBase64(keys.kem.publicKey));
  });

  test('a watch-only account is refused before the vault is asked anything', async () => {
    const { vault, identity } = await fixture(true, { accounts: [account('acct_watch', null)] });
    const active = (await identity.getActiveAccount())!;
    const mnemonic = vi.spyOn(vault, 'withMnemonic');
    const imported = vi.spyOn(vault, 'withImportedPqKeys');
    const error = await withPqKeys(vault, active, async () => 'never').catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account is watch-only, so it cannot use post-quantum keys');
    expect(mnemonic).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  test('a locked vault refuses, and the lock is the reason', async () => {
    const { vault, identity } = await fixture(true, { accounts: [seededAccount('acct_seed', M24)] });
    const active = (await identity.getActiveAccount())!;
    vault.lock();
    await expect(withPqKeys(vault, active, async () => 'never')).rejects.toThrow(/locked/i);
  });

  test('derived secrets are zeroed once the callback returns, and when it throws', async () => {
    const { vault, identity } = await fixture(true, { accounts: [seededAccount('acct_seed', M24)] });
    const active = (await identity.getActiveAccount())!;
    let kem: Uint8Array | null = null;
    let dsa: Uint8Array | null = null;
    await withPqKeys(vault, active, async (scope) => {
      kem = scope.keys.kem.secretKey;
      dsa = scope.keys.dsa.secretKey;
      expect(kem.some((byte) => byte !== 0)).toBe(true);
      expect(dsa.some((byte) => byte !== 0)).toBe(true);
    });
    expect(Array.from(kem!)).toEqual(zeros(kem!.length));
    expect(Array.from(dsa!)).toEqual(zeros(dsa!.length));
    await expect(
      withPqKeys(vault, active, async (scope) => {
        kem = scope.keys.kem.secretKey;
        dsa = scope.keys.dsa.secretKey;
        throw new Error('cipher blew up');
      }),
    ).rejects.toThrow(/cipher blew up/);
    expect(Array.from(kem!)).toEqual(zeros(kem!.length));
    expect(Array.from(dsa!)).toEqual(zeros(dsa!.length));
  });

  test('imported secrets are zeroed once the callback returns', async () => {
    const { stored } = importedPair();
    const { vault, identity } = await fixture(true, { accounts: [account('acct_imp', PRIVKEY_2, { pqKeys: stored })] });
    const active = (await identity.getActiveAccount())!;
    let kem: Uint8Array | null = null;
    let dsa: Uint8Array | null = null;
    await withPqKeys(vault, active, async (scope) => {
      kem = scope.keys.kem.secretKey;
      dsa = scope.keys.dsa.secretKey;
    });
    expect(Array.from(kem!)).toEqual(zeros(kem!.length));
    expect(Array.from(dsa!)).toEqual(zeros(dsa!.length));
  });

  test('a callback that hands the secret back gets zeros out: no accessor returns key material', async () => {
    const { vault, identity } = await fixture(true, { accounts: [seededAccount('acct_seed', M24)] });
    const active = (await identity.getActiveAccount())!;
    const leaked = await withPqKeys(vault, active, async (scope) => scope.keys.kem.secretKey);
    expect(Array.from(leaked)).toEqual(zeros(leaked.length));
  });

  test('a lock inside the callback zeroes the derived secrets there and then, exactly like withPrivkey', async () => {
    // The claim under test is `lock()` reaching key material that is already in flight. Zeroing
    // in a `finally` cannot show it: that runs after the callback, so a callback still computing
    // with live ML-KEM and ML-DSA secrets while `isLocked()` says true would pass. So the bytes
    // are read INSIDE the callback, after the lock, and compared against `withPrivkey`'s copy in
    // the same window — the thing this scope says it behaves exactly like.
    const { vault } = await fixture(true, { accounts: [seededAccount('acct_seed', M24)] });
    const safe = (await vault.getAccountById('acct_seed'))!;
    let privkeyAfterLock: number[] = [];
    let kemAfterLock: number[] = [];
    let dsaAfterLock: number[] = [];
    await expect(
      vault.withPrivkey('acct_seed', (privkey) =>
        withPqKeys(vault, safe, async (scope) => {
          expect(privkey.some((byte) => byte !== 0)).toBe(true);
          expect(scope.keys.kem.secretKey.some((byte) => byte !== 0)).toBe(true);
          expect(scope.keys.dsa.secretKey.some((byte) => byte !== 0)).toBe(true);
          vault.lock();
          privkeyAfterLock = Array.from(privkey);
          kemAfterLock = Array.from(scope.keys.kem.secretKey);
          dsaAfterLock = Array.from(scope.keys.dsa.secretKey);
          return 'computed under a dead session';
        }),
      ),
    ).rejects.toThrow(/session changed/i);
    expect(vault.isLocked()).toBe(true);
    expect(privkeyAfterLock).toEqual(zeros(privkeyAfterLock.length));
    expect(kemAfterLock, 'the derived ML-KEM secret survived the lock').toEqual(zeros(kemAfterLock.length));
    expect(dsaAfterLock, 'the derived ML-DSA secret survived the lock').toEqual(zeros(dsaAfterLock.length));
  });

  test('a lock inside the callback zeroes imported secrets too, and voids the result', async () => {
    const { stored } = importedPair();
    const { vault } = await fixture(true, { accounts: [account('acct_imp', PRIVKEY_2, { pqKeys: stored })] });
    const safe = (await vault.getAccountById('acct_imp'))!;
    let kemAfterLock: number[] = [];
    let dsaAfterLock: number[] = [];
    await expect(
      withPqKeys(vault, safe, async (scope) => {
        vault.lock();
        kemAfterLock = Array.from(scope.keys.kem.secretKey);
        dsaAfterLock = Array.from(scope.keys.dsa.secretKey);
        return 'computed under a dead session';
      }),
    ).rejects.toThrow(/session changed/i);
    expect(kemAfterLock).toEqual(zeros(kemAfterLock.length));
    expect(dsaAfterLock).toEqual(zeros(dsaAfterLock.length));
  });
});

// ── Decrypt routing ──

describe('nip44Decrypt routes on the envelope', () => {
  test('a classic payload decrypts as it does today, and the seed is never read', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, vault } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const ciphertext = nip44.v2.encrypt('classic, as everyone sends today', from.conversationKey);
    expect(isPqEnvelope(ciphertext)).toBe(false);
    const mnemonic = vi.spyOn(vault, 'withMnemonic');
    const imported = vi.spyOn(vault, 'withImportedPqKeys');

    const plaintext = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext }));

    expect(plaintext).toBe('classic, as everyone sends today');
    // Byte-identical to the path everyone uses: the unwrapped signer, with no post-quantum key.
    expect(plaintext).toBe(await new PrivateKeySigner(acct.privkey!).nip44Decrypt(from.pk, ciphertext));
    expect(mnemonic).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  test('a post-quantum payload decrypts through the hybrid path with the account\'s derived key', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, activity } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const ciphertext = hybridPayload('for post-quantum eyes only', from, acct.pubkey, expectedKeys(M24, 0).kem.publicKey);
    expect(isPqEnvelope(ciphertext)).toBe(true);

    const plaintext = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext }));

    expect(plaintext).toBe('for post-quantum eyes only');
    expect(activity.entries.at(-1)).toMatchObject({ method: 'nip44Decrypt', decision: 'allow', scheme: 'pq', ciphertext });
  });

  test('a post-quantum payload decrypts with imported keys', async () => {
    const { keys, stored } = importedPair();
    const acct = account('acct_imp', PRIVKEY_2, { pqKeys: stored });
    const { core } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const ciphertext = hybridPayload('imported, not derived', from, acct.pubkey, keys.kem.publicKey);

    expect(await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext }))).toBe('imported, not derived');
  });

  test('an unrecognised payload fails as operation_failed, never as an empty or partial answer', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, activity } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    // Deliberately not random bytes: a random leading byte is our envelope version one time in
    // 256, which would make this test's `scheme: 'classic'` assertion flaky rather than wrong.
    const notOurs = toBase64(new Uint8Array(200).fill(0x02));
    for (const ciphertext of ['not a ciphertext at all', notOurs, 'AgAAAA==']) {
      const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext })).catch((e: unknown) => e);
      expect(error, ciphertext).toBeInstanceOf(SignerError);
      expect((error as SignerError).code, ciphertext).toBe('operation_failed');
      expect(activity.entries.at(-1), ciphertext).toMatchObject({ decision: 'deny', code: 'operation_failed', scheme: 'classic' });
    }
  });

  test('a payload that names the hybrid envelope and cannot be opened is refused as hybrid, not mislabelled classic', async () => {
    // Probed on the committed code: a truncated or wrong-algorithm envelope answered false to
    // `isPqEnvelope`, so it was routed classic and failed there as `operation_failed` with
    // `activity.scheme = 'classic'`. The payload says 0x01 in its first byte; calling it classic
    // sends whoever is debugging it to the NIP-44 code, which never saw a payload like this.
    const acct = seededAccount('acct_seed', M24);
    const { core, activity } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const whole = hybridPayload('for post-quantum eyes only', from, acct.pubkey, expectedKeys(M24, 0).kem.publicKey);

    const truncated = toBase64(fromBase64(whole).subarray(0, 100));
    const wrongAlg = fromBase64(whole);
    wrongAlg[1] = 0x09;

    for (const [name, ciphertext] of [
      ['truncated', truncated],
      ['an algorithm we do not implement', toBase64(wrongAlg)],
    ] as const) {
      expect(isPqEnvelope(ciphertext), name).toBe(false);
      const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext })).catch((e: unknown) => e);
      expect((error as SignerError).code, name).toBe('operation_failed');
      expect((error as SignerError).message, name).toBe('This post-quantum payload is not a readable hybrid envelope');
      expect(activity.entries.at(-1), name).toMatchObject({
        method: 'nip44Decrypt',
        decision: 'deny',
        code: 'operation_failed',
        scheme: 'pq',
        reason: 'This post-quantum payload is not a readable hybrid envelope',
      });
    }
  });

  test('a post-quantum payload sealed to someone else\'s key fails as operation_failed', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const someoneElse = derivePqKeys(randomBytes(64), 0);
    const ciphertext = hybridPayload('wrong recipient', from, acct.pubkey, someoneElse.kem.publicKey);
    const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('operation_failed');
    expect((error as SignerError).message).toBe('Operation failed');
  });

  test('a post-quantum payload for an account with no seed is refused with the reason, and a classic one still opens', async () => {
    const acct = account('acct_nsec', PRIVKEY_2);
    const { core } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const pq = hybridPayload('unreadable here', from, acct.pubkey, derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: pq })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no seed phrase, so it cannot use post-quantum keys');

    const classic = nip44.v2.encrypt('still fine', from.conversationKey);
    expect(await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: classic }))).toBe('still fine');
  });

  test('a post-quantum payload for a 12-word account is refused with the reason', async () => {
    const acct = seededAccount('acct_12', M12);
    const { core } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const pq = hybridPayload('unreadable here', from, acct.pubkey, derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: pq })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('Post-quantum keys require a 24-word seed phrase');
  });

  test('a stored deny holds before the account\'s shape is disclosed', async () => {
    const acct = account('acct_nsec', PRIVKEY_2);
    const { core, permissions, approval } = await fixture(true, { accounts: [acct] });
    await permissions.save('example.com', 'nip44Decrypt', null, 'deny', acct.id);
    const from = peer(acct.pubkey);
    const pq = hybridPayload('x', from, acct.pubkey, derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: pq })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('permission_denied');
    expect(approval.presented).toHaveLength(0);
  });
});

// ── Remote accounts ──

function remoteAccount(id = 'acct_remote'): Account {
  return account(id, null, { type: 'nip46', pubkey: PUBKEY_2, readOnly: false });
}

function recordingRemote(): RemoteSignerPort & { calls: number } {
  const port = {
    calls: 0,
    async execute() {
      port.calls += 1;
      return 'from the bunker';
    },
  };
  return port;
}

describe('a remote account cannot do post-quantum, and is told so instead of being downgraded', () => {
  test('a post-quantum decrypt is refused before the remote port sees it; a classic one is routed', async () => {
    const remote = recordingRemote();
    const { core, permissions } = await fixture(true, { accounts: [remoteAccount()], remote });
    await permissions.save('example.com', 'nip44Decrypt', null, 'allow', 'acct_remote');
    const from = peer(PUBKEY_2);
    const pq = hybridPayload('x', from, PUBKEY_2, derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: pq })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('Remote signers cannot read post-quantum messages');
    expect(remote.calls).toBe(0);

    const classic = nip44.v2.encrypt('x', from.conversationKey);
    expect(await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: classic }))).toBe('from the bunker');
    expect(remote.calls).toBe(1);
  });

  test('a post-quantum encrypt is refused before the remote port sees it; a classic one is routed', async () => {
    const remote = recordingRemote();
    const { core, permissions } = await fixture(true, { accounts: [remoteAccount()], remote });
    await permissions.save('example.com', 'nip44Encrypt', null, 'allow', 'acct_remote');
    const kem = toBase64(derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core
      .handle(req('nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'x', opts: { scheme: 'pq', recipientKemKey: kem } }))
      .catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('Remote signers do not support post-quantum encryption');
    expect(remote.calls).toBe(0);

    expect(await core.handle(req('nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'x' }))).toBe('from the bunker');
    expect(remote.calls).toBe(1);
  });

  test('the attestation is refused for a remote account', async () => {
    const remote = recordingRemote();
    const { core, permissions } = await fixture(true, { accounts: [remoteAccount()], remote });
    await permissions.save('example.com', 'signEvent', PQC_KIND, 'allow', 'acct_remote');
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('Remote signers do not support post-quantum keys');
    expect(remote.calls).toBe(0);
  });

  test('a stored deny is reported as the deny, not as the account\'s type', async () => {
    const remote = recordingRemote();
    const { core, permissions } = await fixture(true, { accounts: [remoteAccount()], remote });
    await permissions.save('example.com', 'nip44Encrypt', null, 'deny', 'acct_remote');
    const kem = toBase64(derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const error = await core
      .handle(req('nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'x', opts: { scheme: 'pq', recipientKemKey: kem } }))
      .catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('permission_denied');
  });
});

// ── Encrypt policy ──

describe('nip44Encrypt seals post-quantum only when the caller asks, as the extension does', () => {
  test('without opts the result is classic NIP-44, whatever the recipient may have published', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, activity } = await fixture(true, { accounts: [acct] });
    const to = peer(acct.pubkey);
    const ciphertext = (await core.handle(req('nip44Encrypt', { pubkey: to.pk, plaintext: 'plain' }))) as string;
    expect(isPqEnvelope(ciphertext)).toBe(false);
    expect(nip44.v2.decrypt(ciphertext, to.conversationKey)).toBe('plain');
    expect(activity.entries.at(-1)).toMatchObject({ method: 'nip44Encrypt', decision: 'allow', scheme: 'classic', theirPubkey: to.pk });
  });

  test('with opts the result is the hybrid envelope the recipient\'s ML-KEM key opens', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, activity, approval } = await fixture(true, { accounts: [acct] });
    const to = peer(acct.pubkey);
    const theirs = derivePqKeys(randomBytes(64), 0);
    const opts = { scheme: 'pq', recipientKemKey: toBase64(theirs.kem.publicKey) };
    const ciphertext = (await core.handle(req('nip44Encrypt', { pubkey: to.pk, plaintext: 'sealed', opts }))) as string;
    expect(isPqEnvelope(ciphertext)).toBe(true);
    expect(decryptPq(ciphertext, theirs.kem.secretKey, to.conversationKey, { sender: acct.pubkey, recipient: to.pk })).toBe('sealed');
    expect(activity.entries.at(-1)).toMatchObject({ method: 'nip44Encrypt', decision: 'allow', scheme: 'pq', theirPubkey: to.pk });
    // The prompt was shown the request with its options, so a host can say "post-quantum".
    expect(approval.presented[0]!.request.params).toEqual({ pubkey: to.pk, plaintext: 'sealed', opts });
  });

  test('the sender needs its own post-quantum keys too, as the extension requires', async () => {
    const { core } = await fixture(true, { accounts: [account('acct_nsec', PRIVKEY_2)] });
    const to = peer(PUBKEY_2);
    const opts = { scheme: 'pq', recipientKemKey: toBase64(derivePqKeys(randomBytes(64), 0).kem.publicKey) };
    const error = await core.handle(req('nip44Encrypt', { pubkey: to.pk, plaintext: 'x', opts })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no seed phrase, so it cannot use post-quantum keys');
  });

  test('a stored allow for sending messages covers the post-quantum form without a prompt', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, permissions, approval } = await fixture(true, { accounts: [acct] });
    await permissions.save('example.com', 'nip44Encrypt', null, 'allow', acct.id);
    const to = peer(acct.pubkey);
    const opts = { scheme: 'pq', recipientKemKey: toBase64(derivePqKeys(randomBytes(64), 0).kem.publicKey) };
    const ciphertext = (await core.handle(req('nip44Encrypt', { pubkey: to.pk, plaintext: 'x', opts }))) as string;
    expect(isPqEnvelope(ciphertext)).toBe(true);
    expect(approval.presented).toHaveLength(0);
  });

  describe('the options are validated at the boundary, as the extension validates them', () => {
    const kem = toBase64(derivePqKeys(randomBytes(64), 0).kem.publicKey);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['opts on nip04Encrypt', 'nip04Encrypt', { opts: { scheme: 'pq', recipientKemKey: kem } }],
      ['a scheme that is not pq', 'nip44Encrypt', { opts: { scheme: 'classic', recipientKemKey: kem } }],
      ['no scheme', 'nip44Encrypt', { opts: { recipientKemKey: kem } }],
      ['opts that are not an object', 'nip44Encrypt', { opts: 'pq' }],
      ['opts that are null', 'nip44Encrypt', { opts: null }],
      ['a missing recipientKemKey', 'nip44Encrypt', { opts: { scheme: 'pq' } }],
      ['a recipientKemKey that is not a string', 'nip44Encrypt', { opts: { scheme: 'pq', recipientKemKey: 42 } }],
      ['a recipientKemKey of the wrong length', 'nip44Encrypt', { opts: { scheme: 'pq', recipientKemKey: kem.slice(0, 2088) } }],
      ['a recipientKemKey that is not base64', 'nip44Encrypt', { opts: { scheme: 'pq', recipientKemKey: `${kem.slice(0, 2091)}!` } }],
    ];
    test.each(cases)('%s is invalid_request', async (_name, method, extra) => {
      const acct = seededAccount('acct_seed', M24);
      const { core, activity, approval } = await fixture(true, { accounts: [acct] });
      const error = await core
        .handle(req(method as 'nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'x', ...extra }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SignerError);
      expect((error as SignerError).code).toBe('invalid_request');
      expect(approval.presented).toHaveLength(0);
      expect(activity.entries).toHaveLength(0);
    });
  });
});

// ── The attestation ──

describe('signPqAttestation is a signing request like any other', () => {
  test('a derived account signs a kind:10203 that verifies, with origin derived and a 256-bit seed', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, vault, activity, approval } = await fixture(true, { accounts: [acct] });
    const event = (await core.handle(req('signPqAttestation'))) as Event;

    expect(event.kind).toBe(PQC_KIND);
    expect(event.pubkey).toBe(acct.pubkey);
    expect(event.content).toBe('');
    expect(event.created_at).toBe(Math.floor(vault.now() / 1000));
    expect(verifyEvent(event)).toBe(true);
    const tag = (name: string) => event.tags.find((t) => t[0] === name);
    expect(tag('origin')).toEqual(['origin', 'derived']);
    expect(tag('seed_strength')).toEqual(['seed_strength', '256']);
    expect(tag('v')).toEqual(['v', 'nip-pqc/v1']);
    const expected = expectedKeys(M24, 0);
    expect(event.tags.find((t) => t[0] === 'alg' && t[1] === ALG_KEM)![2]).toBe(toBase64(expected.kem.publicKey));
    expect(event.tags.find((t) => t[0] === 'alg' && t[1] === ALG_DSA)![2]).toBe(toBase64(expected.dsa.publicKey));
    // The tags are exactly the extension's, in the extension's order.
    expect(event.tags.map((t) => t[0])).toEqual(['alg', 'alg', 'origin', 'seed_strength', 'v', 'pop']);

    const verified = verifyPqAttestation(JSON.parse(JSON.stringify(event)) as Event);
    expect(verified.usable).toBe(true);
    expect(verified.popValid).toBe(true);
    expect(verified.kem).toEqual(expected.kem.publicKey);

    expect(activity.entries.at(-1)).toMatchObject({ method: 'signPqAttestation', kind: PQC_KIND, decision: 'allow', pubkey: acct.pubkey });
  });

  test('the prompt is shown the event that will be signed, spelled as the signEvent it is', async () => {
    // The user cannot consent to "signPqAttestation" with nothing attached: the keys, the tags
    // and the proof of possession are all this pipeline's to compute, so it computes them
    // BEFORE asking and shows the kind:10203 in full, exactly as a `signEvent` template is
    // shown. A host that switches on `request.method` therefore reaches its existing event
    // preview, with no case for a name it has never heard of.
    const acct = seededAccount('acct_seed', M24);
    const { core, approval } = await fixture(true, { accounts: [acct] });
    const event = (await core.handle(req('signPqAttestation'))) as Event;

    expect(approval.presented).toHaveLength(1);
    const shown = approval.presented[0]!.request;
    expect(shown.method).toBe('signEvent');
    const template = (shown.params as { event: EventTemplateInput }).event;
    expect(template.kind).toBe(PQC_KIND);
    expect(template.content).toBe('');
    // Not a summary, not a count: every tag the signature will cover, in order, with values.
    expect(template.tags).toEqual(event.tags);
    expect(template.created_at).toBe(event.created_at);
    // What was shown is what was signed, down to the proof of possession — which is randomised,
    // so rebuilding the event after the prompt would have produced a different `pop` tag.
    expect(template.tags.find((t) => t[0] === 'pop')).toEqual(event.tags.find((t) => t[0] === 'pop'));
    // And the prompt cannot be edited into something else on its way to the signer.
    expect(Object.isFrozen(shown)).toBe(true);
    expect(Object.isFrozen(template.tags)).toBe(true);
  });

  test('the batch prompt shows the attestation as an event too, beside the items around it', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, approval } = await fixture(true, { accounts: [acct] });
    const result = await core.handleBatch({
      id: nextId('batch'),
      origin: { kind: 'web', identifier: 'example.com' },
      items: [
        { id: 'a', method: 'signPqAttestation', params: {} },
        { id: 'b', method: 'signEvent', params: { event: { kind: 1, content: 'hello', tags: [] } } },
      ],
      receivedAt: Date.now(),
    });
    expect(result.items.map((item) => item.ok)).toEqual([true, true]);
    const shown = approval.presentedBatches[0]!.batch;
    expect(shown.items.map((item) => item.method)).toEqual(['signEvent', 'signEvent']);
    const signed = (result.items[0] as { result: Event }).result;
    const template = (shown.items[0]!.params as { event: EventTemplateInput }).event;
    expect(template.kind).toBe(PQC_KIND);
    expect(template.tags).toEqual(signed.tags);
    expect(shown.items[1]!.params).toEqual({ event: { kind: 1, content: 'hello', tags: [] } });
  });

  test('an attestation the account cannot produce is refused before the user is asked', async () => {
    // The event is the disclosure. There is nothing honest to show for an account whose keys
    // cannot be resolved, so the refusal comes instead of the prompt, not after it.
    const { core, approval, activity } = await fixture(true, { accounts: [account('acct_nsec', PRIVKEY_2)] });
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no seed phrase, so it cannot use post-quantum keys');
    expect(approval.presented).toHaveLength(0);
    expect(activity.entries.at(-1)).toMatchObject({ method: 'signPqAttestation', decision: 'deny', code: 'unsupported' });
  });

  test('an account with imported keys signs origin independent and claims no seed strength', async () => {
    const { keys, stored } = importedPair();
    const acct = account('acct_imp', PRIVKEY_2, { pqKeys: stored });
    const { core } = await fixture(true, { accounts: [acct] });
    const event = (await core.handle(req('signPqAttestation'))) as Event;
    const tag = (name: string) => event.tags.find((t) => t[0] === name);
    expect(tag('origin')).toEqual(['origin', 'independent']);
    expect(tag('seed_strength')).toBeUndefined();
    expect(event.tags.map((t) => t[0])).toEqual(['alg', 'alg', 'origin', 'v', 'pop']);
    const verified = verifyPqAttestation(JSON.parse(JSON.stringify(event)) as Event);
    expect(verified.usable).toBe(true);
    expect(verified.kem).toEqual(keys.kem.publicKey);
  });

  test('a stored deny for signEvent kind 10203 refuses it without a prompt', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, permissions, approval, activity } = await fixture(true, { accounts: [acct] });
    await permissions.save('example.com', 'signEvent', PQC_KIND, 'deny', acct.id);
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('permission_denied');
    expect(approval.presented).toHaveLength(0);
    expect(activity.entries.at(-1)).toMatchObject({ method: 'signPqAttestation', kind: PQC_KIND, decision: 'deny', code: 'permission_denied' });
  });

  test('a blanket signEvent deny refuses it too', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, permissions } = await fixture(true, { accounts: [acct] });
    await permissions.save('example.com', 'signEvent', null, 'deny', acct.id);
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('permission_denied');
  });

  test('a stored allow for kind 10203 signs without a prompt; a remembered approval is stored under that rule', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core, permissions, approval } = await fixture(true, { accounts: [acct] });
    approval.decide = async () => ({ allow: true, remember: true });
    await core.handle(req('signPqAttestation'));
    expect(approval.presented).toHaveLength(1);
    expect(await permissions.check('example.com', 'signEvent', PQC_KIND, acct.id)).toBe('allow');
    expect(await permissions.check('example.com', 'signEvent', 1, acct.id)).toBe('ask');
    await core.handle(req('signPqAttestation'));
    expect(approval.presented).toHaveLength(1);
  });

  test('a refusal at the prompt is the user\'s answer', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core } = await fixture(false, { accounts: [acct] });
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('rejected');
  });

  test('a watch-only account is refused as any key method is', async () => {
    const { core } = await fixture(true, { accounts: [account('acct_watch', null)] });
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no signing key');
  });

  test('a locked vault with no unlock port refuses it after the permission gate, and before the prompt', async () => {
    // The order the attestation runs in, and the one place it differs from every other method:
    // its event is computed from the account's own post-quantum keys, so a shut vault means
    // there is nothing to show. Asking first would put a prompt on screen that names an
    // operation and displays nothing, then refuse it anyway.
    const acct = seededAccount('acct_seed', M24);
    const { core, approval } = await fixture(true, { accounts: [acct], locked: true });
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('vault_locked');
    expect(approval.presented).toHaveLength(0);
  });

  test('a locked vault is opened first, then the built event is shown, then it signs', async () => {
    const acct = seededAccount('acct_seed', M24);
    const order: string[] = [];
    const { core, approval, vault } = await fixture(true, {
      accounts: [acct],
      locked: true,
      unlock: {
        async requestUnlock() {
          order.push('unlock');
          await vault.unlock(PASSWORD);
        },
      },
    });
    approval.decide = async () => {
      order.push('prompt');
      return { allow: true };
    };
    const event = (await core.handle(req('signPqAttestation'))) as Event;
    expect(order).toEqual(['unlock', 'prompt']);
    expect((approval.presented[0]!.request.params as { event: EventTemplateInput }).event.tags).toEqual(event.tags);
  });

  test('the attestation can ride in a batch with the events that will follow it', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core } = await fixture(true, { accounts: [acct] });
    const result = await core.handleBatch({
      id: nextId('batch'),
      origin: { kind: 'web', identifier: 'example.com' },
      items: [
        { id: 'a', method: 'signPqAttestation', params: {} },
        { id: 'b', method: 'signEvent', params: { event: { kind: 1, content: 'now reachable post-quantum', tags: [] } } },
      ],
      receivedAt: Date.now(),
    });
    expect(result.items.map((item) => item.ok)).toEqual([true, true]);
    const attestation = (result.items[0] as { result: Event }).result;
    expect(verifyPqAttestation(JSON.parse(JSON.stringify(attestation)) as Event).usable).toBe(true);
  });

  test('takes no params: anything else is refused at the boundary', async () => {
    const acct = seededAccount('acct_seed', M24);
    const { core } = await fixture(true, { accounts: [acct] });
    const error = await core.handle(req('signPqAttestation', { event: { kind: 1 } })).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('invalid_request');
  });
});

describe('verifyPqAttestation is the check for someone else\'s kind:10203', () => {
  test('accepts a genuine one and refuses a forged, re-attributed or wrong-kind one', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const keys = derivePqKeys(randomBytes(64), 0);
    const tags = buildAttestationTags({ pubkey, kem: keys.kem.publicKey, dsa: keys.dsa.publicKey, origin: 'derived', dsaSecretKey: keys.dsa.secretKey });
    const genuine = JSON.parse(JSON.stringify(finalizeEvent({ kind: PQC_KIND, created_at: 1, content: '', tags }, sk))) as Event;
    expect(verifyPqAttestation(genuine).usable).toBe(true);
    // parseAttestation alone would accept the re-attributed copy: it does not check the signature.
    // Built from fresh JSON: `verifyEvent` marks the object it verified, and a spread would carry that.
    const reattributed = { ...(JSON.parse(JSON.stringify(genuine)) as Event), pubkey: getPublicKey(generateSecretKey()) };
    expect(parseAttestation(reattributed).problems.map((p) => p.code)).not.toContain('badSignature');
    expect(verifyPqAttestation(reattributed).problems.map((p) => p.code)).toContain('badSignature');
    expect(verifyPqAttestation({ ...genuine, kind: 1 }).problems.map((p) => p.code)).toContain('wrongKind');
  });
});
