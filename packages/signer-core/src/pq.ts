/**
 * Post-quantum key material, and the one way to reach it.
 *
 * An account's ML-KEM-1024 and ML-DSA-87 keys are resolved exactly as the extension's
 * `activePqKeys` resolves them, in the same order and for the same reasons:
 *
 *   1. Imported keys win. An account only holds them when it could not derive, and they
 *      are what its published attestation advertises; deriving for such an account would
 *      produce keys that decrypt nothing anyone sent.
 *   2. Otherwise the keys are derived from the account's seed phrase, at the account's own
 *      derivation path, so two accounts on one seed do not share keys and an account
 *      restored at a custom path derives under that path. Nothing is stored: the keys are a
 *      deterministic function of the mnemonic already in the vault, so they are recomputed
 *      per request and there is no additional secret at rest.
 *   3. Only a 24-word phrase may derive. A 12-word phrase carries 128 bits, which would be
 *      the weakest link, so such an account is told to import instead rather than handed a
 *      weak key that looks strong.
 *
 * The secrets never leave {@link withPqKeys}: the callback computes and returns, and every
 * secret is registered with the vault for the duration through `withDerivedSecrets`, so one
 * `lock()` zeroes the derived ML-KEM and ML-DSA keys where they are — mid-callback, not when
 * the callback happens to finish — and a result computed under a session that moved is voided,
 * as `withPrivkey` and `withImportedPqKeys` void theirs. The refusals carry the extension's
 * text, which reaches the caller on purpose: `window.nostr.nip44.schemes` advertises what
 * the signer accepts, not what the selected account can do, so a caller that correctly
 * detected support can still land here, and the only way it can tell the user what to
 * change is if the refusal says which of the reasons it hit. That disclosure happens only
 * after the permission gate and any prompt, never before consent.
 */
import type { SafeAccount } from '@nostr-wot/accounts';
import { mnemonicToSeed } from '@nostr-wot/accounts';
import type { Vault } from '@nostr-wot/vault';
import { derivePqKeys, fromBase64, type PqKeys } from '@nostr-wot/pq';
import { SignerError } from './errors.js';
import type { ValidatedParams } from './types.js';

/** Words a seed phrase needs to derive post-quantum keys: 256 bits, as the extension requires. */
export const PQ_SEED_WORD_COUNT = 24;

/**
 * What {@link withPqKeys} hands its callback. `keys` is live key material for the duration
 * of the callback and zeros afterwards; `source` says whether the account derived them from
 * its seed (recoverable from the phrase alone) or imported them (a separate secret the user
 * has to back up), which is what the attestation's `origin` tag states.
 */
export interface PqKeyScope {
  source: 'derived' | 'imported';
  keys: PqKeys;
}

/** The extension's refusals, spelled the same. */
const WATCH_ONLY = 'This account is watch-only, so it cannot use post-quantum keys';
const NO_SEED = 'This account has no seed phrase, so it cannot use post-quantum keys';
const SHORT_SEED = 'Post-quantum keys require a 24-word seed phrase';

const decoder = new TextDecoder();

/** Whitespace-separated words, ignoring leading, trailing and repeated whitespace. */
function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * Run `fn` with the account's post-quantum keys, resolved as described on this module, and zero
 * every secret afterwards on every path — and, because they are registered with the vault, the
 * moment the vault is locked, whether or not `fn` has returned. Exactly like `withPrivkey`,
 * which `pq.test.ts` holds this to by locking mid-callback and reading both.
 *
 * Refuses, as a `SignerError` with code `unsupported` and the extension's text, an account
 * that is watch-only, has no seed phrase, or has a phrase shorter than 24 words and no
 * imported keys. Throws the vault's own errors when the vault is locked or the session moved
 * while `fn` ran, in which case whatever `fn` computed is not returned.
 *
 * `account` is the account the request was resolved and shown for, never "whatever is
 * active now", for the reason `withPrivkey` takes an id: a request approved as one identity
 * must not be answered with another's keys.
 */
export async function withPqKeys<T>(
  vault: Vault,
  account: SafeAccount,
  fn: (scope: PqKeyScope) => Promise<T>,
): Promise<T> {
  if (account.readOnly) throw new SignerError('unsupported', WATCH_ONLY);
  // The two probes below answer false while locked, and "no seed phrase" would be the wrong
  // reason for a vault that simply is not open. The lock is named as the vault names it.
  if (vault.isLocked()) throw new Error('Vault is locked');

  if (vault.hasImportedPqKeys(account.id)) {
    // The vault's copies, handed straight through: it zeroes them the moment `fn` returns
    // and voids the result if the session moved. Nothing here needs a copy of its own.
    return vault.withImportedPqKeys(account.id, (imported) =>
      fn({
        source: 'imported',
        keys: {
          kem: { publicKey: fromBase64(imported.kemPublic), secretKey: imported.kemSecret },
          dsa: { publicKey: fromBase64(imported.dsaPublic), secretKey: imported.dsaSecret },
        },
      }),
    );
  }

  if (!vault.hasMnemonic(account.id)) throw new SignerError('unsupported', NO_SEED);
  return vault.withMnemonic(account.id, async (phrase) => {
    // A string at the last moment, inside the scope, because the BIP-39 library wants one;
    // the vault's copy stays zeroable. See `Vault.withMnemonic`.
    const mnemonic = decoder.decode(phrase);
    if (countWords(mnemonic) !== PQ_SEED_WORD_COUNT) throw new SignerError('unsupported', SHORT_SEED);
    const seed = mnemonicToSeed(mnemonic);
    let keys: PqKeys;
    try {
      // The path when the account was restored at one, else its NIP-06 index: the
      // extension's `acct.derivationPath ?? acct.derivationIndex ?? 0`.
      keys = derivePqKeys(seed, account.derivationPath ?? account.derivationIndex ?? 0);
    } finally {
      // The seed is the whole identity. It exists only to be expanded, and it is gone
      // before the callback runs.
      seed.fill(0);
    }
    // Handed to the vault, not zeroed here. A `finally` of our own would cover the return and
    // the throw and miss the lock, which is the case that matters: `lock()` is the user saying
    // "let go of my keys now", and secrets the vault has never been told about are the ones it
    // cannot reach. `withDerivedSecrets` registers them in the same live-key set `withPrivkey`
    // puts its copy in, so one `lock()` zeroes both, and zeroes them again on the way out.
    return vault.withDerivedSecrets([keys.kem.secretKey, keys.dsa.secretKey], () =>
      fn({ source: 'derived', keys }),
    );
  });
}

/**
 * Whether a validated request needs the account's post-quantum keys: a hybrid encrypt, a
 * decrypt of a self-describing post-quantum payload, or the attestation.
 */
export function needsPqKeys(params: ValidatedParams): boolean {
  switch (params.method) {
    case 'nip44Encrypt':
    case 'nip44Decrypt':
      return params.scheme === 'pq';
    case 'signPqAttestation':
      return true;
    default:
      return false;
  }
}

/**
 * The refusal for a remote-signer account, per method, in the extension's words.
 *
 * A bunker knows nothing about the envelope. It answers a hybrid `nip44Encrypt` with
 * ordinary NIP-44 ciphertext and a post-quantum `nip44Decrypt` with garbage or an error, and
 * the caller of the first cannot tell classic from hybrid: that is the silent downgrade the
 * opt-in exists to prevent, and it cannot be caught inside the local execute step, which a
 * remote account never reaches. So it is refused at the routing step, after the permission
 * gate, before anything is sent. `null` for a request a remote account may make.
 */
export function remotePqRefusal(params: ValidatedParams): string | null {
  if (!needsPqKeys(params)) return null;
  switch (params.method) {
    case 'nip44Encrypt':
      return 'Remote signers do not support post-quantum encryption';
    case 'nip44Decrypt':
      return 'Remote signers cannot read post-quantum messages';
    default:
      return 'Remote signers do not support post-quantum keys';
  }
}
