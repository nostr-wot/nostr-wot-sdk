/**
 * Moving accounts between the stored JSON shape and the in-memory one.
 *
 * Ported from the browser extension's `src/services/vault/serialization.ts`, with its
 * `@lib/crypto/utils.ts` helpers replaced by local ones: `@noble/hashes` for hex and
 * `@scure/base` for base64, because `btoa`/`atob` are browser globals and this package has to
 * run where there are none.
 *
 * The point of the memory shape is that `lock()` can zero the secrets. A JavaScript string is
 * immutable and unreachable to overwrite, so an nsec held as a string stays in the heap until
 * the collector gets to it; held as a `Uint8Array` it can be filled with zeroes on the spot.
 */
import { base64 } from '@scure/base';
import { bytesToHex as nobleBytesToHex, hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import type { Account } from '@nostr-wot/accounts';
import type { MemoryAccount, MemoryVaultPayload, VaultPayload } from './types.js';

/**
 * Standard base64, with padding — the alphabet `btoa` emits and `atob` accepts.
 *
 * Not URL-safe and not unpadded. The extension parses these fields with `atob`, which rejects
 * the URL-safe alphabet outright, so a record written with anything else would be unopenable
 * there while every test in this package still passed.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

/** Inverse of {@link bytesToBase64}. Throws on input that is not standard padded base64. */
export function base64ToBytes(value: string): Uint8Array {
  return base64.decode(value);
}

/** Lowercase hex, the encoding `privkey` uses on a stored account. */
export function bytesToHex(bytes: Uint8Array): string {
  return nobleBytesToHex(bytes);
}

/** Inverse of {@link bytesToHex}. */
export function hexToBytes(hex: string): Uint8Array {
  return nobleHexToBytes(hex);
}

/**
 * Stored account -> in-memory account.
 *
 * Everything that is not a secret rides along in `...rest` untouched, including fields this
 * package does not model. The extension stores `walletConfig` on an account; a host that read
 * a vault, dropped the field and saved would silently destroy the user's wallet connection, so
 * unknown fields are carried, never filtered.
 */
export function toMemoryAccount(acct: Account): MemoryAccount {
  const { privkey, mnemonic, pqKeys, ...rest } = acct;
  return {
    ...rest,
    privkeyBytes: privkey ? hexToBytes(privkey) : null,
    mnemonicBytes: mnemonic ? new TextEncoder().encode(mnemonic) : null,
    // Imported post-quantum secrets get the same treatment as the nsec: held as bytes so
    // lock() can zero them, rather than as strings that linger until GC.
    //
    // `undefined` when the stored account had no `pqKeys` field at all, `null` when it had an
    // explicit null. Both mean "no imported keys"; keeping them apart is what makes the round
    // trip back to storage lossless.
    // `!== undefined` rather than `Object.hasOwn`: a property explicitly set to `undefined` is
    // "own" but means the same thing as absent, and JSON.stringify drops it either way.
    ...(acct.pqKeys !== undefined
      ? {
          pqPublic: pqKeys
            ? {
                profile: pqKeys.profile,
                kem: pqKeys.kem.public,
                dsa: pqKeys.dsa.public,
                importedAt: pqKeys.importedAt,
              }
            : null,
        }
      : {}),
    pqKemSecretBytes: pqKeys ? base64ToBytes(pqKeys.kem.secret) : null,
    pqDsaSecretBytes: pqKeys ? base64ToBytes(pqKeys.dsa.secret) : null,
  };
}

/** In-memory account -> stored account. Inverse of {@link toMemoryAccount}, losslessly. */
export function toStorageAccount(acct: MemoryAccount): Account {
  const { privkeyBytes, mnemonicBytes, pqPublic, pqKemSecretBytes, pqDsaSecretBytes, ...rest } = acct;
  return {
    ...rest,
    privkey: privkeyBytes ? bytesToHex(privkeyBytes) : null,
    mnemonic: mnemonicBytes ? new TextDecoder().decode(mnemonicBytes) : null,
    // See the note in toMemoryAccount: `undefined` means absent, and `Object.hasOwn` would call
    // a hand-built `{ pqPublic: undefined }` present and write back an explicit `pqKeys: null`.
    ...(acct.pqPublic !== undefined
      ? {
          pqKeys:
            pqPublic && pqKemSecretBytes && pqDsaSecretBytes
              ? {
                  profile: pqPublic.profile,
                  kem: { public: pqPublic.kem, secret: bytesToBase64(pqKemSecretBytes) },
                  dsa: { public: pqPublic.dsa, secret: bytesToBase64(pqDsaSecretBytes) },
                  importedAt: pqPublic.importedAt,
                }
              : null,
        }
      : {}),
  };
}

/** In-memory vault -> the JSON shape that gets encrypted into a {@link VaultRecord}. */
export function toStoragePayload(mem: MemoryVaultPayload): VaultPayload {
  return {
    accounts: mem.accounts.map(toStorageAccount),
    ...(mem.cacheKeyBytes && { cacheKey: bytesToBase64(mem.cacheKeyBytes) }),
    activeAccountId: mem.activeAccountId,
  };
}

/** Stored vault -> the in-memory shape, with every secret as zeroable bytes. */
export function toMemoryPayload(payload: VaultPayload): MemoryVaultPayload {
  return {
    ...(payload.cacheKey ? { cacheKeyBytes: base64ToBytes(payload.cacheKey) } : {}),
    accounts: payload.accounts.map(toMemoryAccount),
    activeAccountId: payload.activeAccountId,
  };
}

/**
 * Zero every secret an unlocked account holds.
 *
 * The reason the memory shape exists at all. After this the account is still a valid object
 * with its public metadata intact, and every byte of key material in it is zero.
 */
export function zeroMemoryAccount(acct: MemoryAccount): void {
  acct.privkeyBytes?.fill(0);
  acct.mnemonicBytes?.fill(0);
  acct.pqKemSecretBytes?.fill(0);
  acct.pqDsaSecretBytes?.fill(0);
}

/**
 * Zero every secret an unlocked vault holds: the cache key and each account's key material.
 *
 * What `lock()` runs. It deliberately zeroes rather than dropping the references, because
 * dropping a reference only makes the bytes unreachable to this code, not to whatever else
 * can read the heap — a crash dump, a debugger, a memory-scraping page, the swap file the
 * process was paged out to. The buffers stay in place and readable until the collector
 * happens to get to them, which is not a guarantee anyone can make about an nsec.
 *
 * The payload is left structurally intact, with its public metadata: it is the secrets that
 * are destroyed, not the object.
 */
export function zeroMemoryPayload(payload: MemoryVaultPayload): void {
  payload.cacheKeyBytes?.fill(0);
  for (const account of payload.accounts) zeroMemoryAccount(account);
}
