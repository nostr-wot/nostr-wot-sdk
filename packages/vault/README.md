# @nostr-wot/identity/vault

> Package consolidation: this is the API guide for `@nostr-wot/identity/vault`. The former `@nostr-wot/vault` package is a deprecated compatibility re-export. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

The vault cryptography every `@nostr-wot/*` host shares: PBKDF2-HMAC-SHA-256 key derivation and AES-256-GCM, in pure JavaScript.

The point of this package is that it needs no WebCrypto. React Native has no `crypto.subtle`, so a signer written against WebCrypto cannot be shared with a mobile app. This one produces and consumes exactly the bytes the browser extension's WebCrypto implementation does, so a vault written in the extension opens on a phone and the other way round. That byte compatibility is covered by `test/webcrypto-compat.test.ts`, which checks both directions against `node:crypto`'s WebCrypto.

## Install

```bash
npm i @nostr-wot/identity
```

### Module format

Use ESM `import` as shown here. Module-format support is specific to the owning package and entry point; do not infer it from another package in the family. The identity entry points are ESM-only.

## Format version 1

| Parameter | Value |
| --- | --- |
| KDF | PBKDF2-HMAC-SHA-256 |
| Iterations | 600000, or 210000 for the empty password |
| Cipher | AES-256-GCM |
| Salt | 16 bytes |
| IV | 12 bytes |

These are fixed. Vaults in the field were written with them, so changing one means a new format version and a migration, not an edit.

## Usage

```ts
import { iterationsFor, noblePbkdf2, encrypt, decrypt } from '@nostr-wot/identity/vault';

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await noblePbkdf2.derive(password, salt, iterationsFor(password));

const { iv, ciphertext } = encrypt(key, mnemonic);
const recovered = decrypt(key, iv, ciphertext); // throws if the key is wrong
```

`ciphertext` carries the 16-byte GCM tag appended, which is the layout WebCrypto returns and expects. `decrypt` throws when the tag does not authenticate: a wrong key fails loudly rather than returning plausible garbage.

Both functions reject any key that is not exactly 32 bytes. AES itself accepts 16 and 24, so without that check a port returning a short key would silently produce AES-128 vaults and report success.

The caller owns the lifetime of the derived key and of the recovered plaintext. This package cannot zero either — a JavaScript string is immutable, so a decrypted mnemonic stays readable in the heap until the collector reclaims it. Hand it to whatever consumes it and do not stash it.

## The empty password

`iterationsFor('')` returns the lower work factor on purpose. A "never lock" vault is stored under a password the source code supplies in public, so anyone holding the encrypted blob also holds the password and no amount of stretching makes it harder to open. The work factor buys nothing there and only costs latency on a path that runs at every cold start. A vault with a real password gets the full 600000, where stretching is the whole defence.

## `Pbkdf2Port`

Pure JavaScript PBKDF2 at 600000 iterations costs roughly a second on a phone. The default `noblePbkdf2` is pure JavaScript so the package works everywhere with no native dependency; a host that has a hardware accelerated PBKDF2 can implement the same interface and inject it.

```ts
interface Pbkdf2Port {
  derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
}
```

It is not on the common unlock path, which uses the hardware wrapped key rather than the password.

## The record format

A vault on disk is one `VaultRecord`: `version`, base64 `salt` / `iv` / `ciphertext`, and the PBKDF2 `iterations` the record was written with.

```ts
const record = await sealPayload({ accounts, activeAccountId }, password, noblePbkdf2);
const { payload, cacheKeyMinted } = await openRecord(record, password, noblePbkdf2);
if (cacheKeyMinted) await store(await sealPayload(payload, password, noblePbkdf2));
```

`cacheKeyMinted` is not optional to handle. A record whose plaintext has no `cacheKey` predates the field; the reader invents one so the caller never has to handle its absence, but the invented key only becomes the vault's cache key once the record is re-sealed and stored. A host that ignores the flag mints a different key on every unlock, and everything written to the private cache under the previous one silently stops decrypting.

`iterations` is optional, and that is not an oversight. Records written before the work factor was raised carry no such field and were every one of them written at 210000, so `openRecord` falls back to that count rather than recomputing from the password. Recomputing would derive at 600000 and refuse to open exactly the oldest vaults in the field.

`openRecord` reads the count off the record for the same reason: raising the constant must never lock anyone out. `sealPayload` writes the current count, so a record re-sealed after an unlock comes back at full strength.

## Memory accounts

An unlocked account holds its secrets as `Uint8Array`, not as strings, so `lock()` can zero them. A JavaScript string cannot be overwritten: an nsec held as one stays readable in the heap until the collector happens to reclaim it.

```ts
const mem = toMemoryAccount(stored);   // privkeyBytes, mnemonicBytes, pq*SecretBytes, nip46.{secretBytes,localPrivkeyBytes}
zeroMemoryAccount(mem);                // every byte of key material is now zero
const back = toStorageAccount(mem);    // lossless, including fields this package does not model
```

The round trip carries unknown fields through untouched. The browser extension stores `walletConfig` on an account and this package deliberately does not model it; a host that read a vault, dropped the field and saved would silently destroy the user's wallet connection.

## The `Vault`

`Vault` is the lifecycle over one injected `KeyValueStore`: `create`, `unlock`, `lock`, `destroy`, `changePassword`, the brute-force guard and the auto-lock. Nothing on it ever returns key material. Every secret is reached through a scoped accessor that hands a callback a copy, zeroes the copy on every path, and voids the result if the vault was locked while the callback ran:

| Accessor | Hands `fn` |
| --- | --- |
| `withPrivkey(accountId, fn)` | the 32-byte private key |
| `withMnemonic(accountId, fn)` | the seed phrase as UTF-8 bytes |
| `withImportedPqKeys(accountId, fn)` | the imported ML-KEM / ML-DSA secrets, with the public halves and profile |
| `withCacheKey(fn)` | the 32-byte private-cache key |
| `withRemoteSignerCredentials(accountId, fn)` | a NIP-46 account's config, local key and connect token as bytes |

The callback computes and returns; it must not externalize anything, because a void arrives after a publish has already happened. The doc comment on `withPrivkey` has the full contract.

Account mutations each re-seal the record under the key already in memory, so none needs the password: `addAccount`, `removeAccount` (which also moves the session on, voiding any callback still holding that account's key), `updateAccountNip46Keys`, `setImportedPqKeys` and `clearImportedPqKeys`. A write the store refuses is undone in memory, so the open vault never describes a record that was not saved. `listAccounts` and `getAccountById` return public metadata through the `SafeAccount` allowlist; for a NIP-46 account the latter adds the public half of the connection (bunker pubkey, relay, local pubkey), never the credentials.

## The golden vector

`test/fixtures/extension-vault-v1.json` was produced by `scripts/generate-extension-fixture.mjs`, which imports nothing from `src/` and instead reimplements the browser extension's own writer against Node's WebCrypto. The test suite opens it with `openRecord` and, in the other direction, decrypts a `sealPayload` record with WebCrypto directly. Two independent implementations agreeing on the bytes is the only evidence that means anything; a fixture sealed by the code under test would stay green through a format change that breaks every vault in the field.

## Host requirements

The portable account, vault, permission and signing modules use injected storage and host ports. They require `TextEncoder`, `TextDecoder`, secure `crypto.getRandomValues`, timers and `AbortController`; post-quantum paths additionally require `atob`/`btoa` or the supported Buffer fallback. Initialize the necessary React Native/Hermes polyfills before importing these modules, including `react-native-get-random-values` for secure randomness. Do not substitute a non-cryptographic random source.

The portable cryptographic core does not require the DOM, WebExtension APIs or WebCrypto `subtle`. Platform adapters such as WebAuthn ceremonies and relay transports have their own requirements. See the [identity runtime guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/identity/README.md#runtime-requirements).

This package uses `TextEncoder` and `TextDecoder` directly: for the password and the plaintext in `crypto.ts`, and for the mnemonic and NIP-46 secrets in `serialization.ts`.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Passkey record primitives

The `Vault` class remains the password-protected version 1 lifecycle. It rejects other record versions/protection modes on password unlock and preserves `registeredPasskeys` when saving or changing a password. Its `clearActiveAccount()` clears only the in-memory selection and revokes outstanding scoped capabilities; the stored selection is restored on the next unlock unless another mutation saves it. `destroyIfEmpty()` deletes only an authenticated, unlocked empty vault, serializes against mutations, zeroes secrets and invokes destroy listeners. Locked state or an account added ahead of cleanup prevents deletion. `getAccountRemovalInfo(id)` returns typed `AccountRemovalInfo` with a portable `reason` (`key`, `only-seed`, `main-seed`, `derived-seed` or `sibling-seed`) and `relatedCount` without releasing seed material; the host maps these reasons to localized warnings.

Version 2 passkey records use separate portable functions: `createPasskeyRecord`, `openPasskeyRecord`, `sealPasskeyPayload`, `wrapVaultKey`, `withPasskeyVaultKey`, `parsePasskeyBackup` and `serializePasskeyBackup`. They implement the extension's HKDF-SHA256 PRF wrapping and AES-256-GCM record format, including authenticated credential/RP/salt binding and bounded recovery-file validation. New registrations default to `passkeys.nostrwot.com`; existing credentials retain their original RP and custom registrations carry it per wrapper; these functions do not register, request or verify native WebAuthn assertions. Hosts obtain the PRF response and own user verification, storage, mutation serialization, lock/session revocation, protection switching, recovery authorization and provider recovery blobs. Do not pass a v2 record to `Vault.unlock()`.

```ts
import {
  createPasskeyRecord, openPasskeyRecord, sealPasskeyPayload,
  withPasskeyVaultKey, wrapVaultKey, parsePasskeyBackup, serializePasskeyBackup,
} from '@nostr-wot/identity/vault';

// enrollment/proof come from the host's authenticator ceremony; never store/log their prf.
const record = createPasskeyRecord(payload, enrollment);
const opened = await openPasskeyRecord(record, proof);
const updated = await withPasskeyVaultKey(record, proof, key =>
  sealPasskeyPayload(opened.payload, key, record),
);
// Store updated atomically after checking the host session still authorizes this write.
const withSecondPasskey = await withPasskeyVaultKey(updated, proof, key =>
  sealPasskeyPayload(opened.payload, key, {
    rpId: updated.rpId,
    passkeys: [...updated.passkeys, wrapVaultKey(key, secondEnrollment)],
  }),
);
const backup = serializePasskeyBackup(withSecondPasskey);
const recovered = await openPasskeyRecord(parsePasskeyBackup(backup), secondProof);
// Check current-vault replacement policy before persisting the recovered record.
```

`withPasskeyVaultKey` zeroes its temporary vault key on success and failure, but has no host session to revoke; a host must enforce its own revision checks around asynchronous work. `unwrapVaultKey` is the lower-level alternative: its returned key belongs to the caller and must be zeroed in `finally`. PRF values and decrypted payload strings cannot be erased by JavaScript; minimize their lifetime. When `openPasskeyRecord` reports `cacheKeyMinted`, re-seal and persist the returned payload before using its cache key. Re-seal existing payloads instead of creating a new record when updating accounts, so the private-cache key and existing passkey enrollment remain stable.

## Provider and relay recovery

`saveRecovery` and `restoreRecovery` support PRF-encrypted private keys, seeds and full vault payloads through injected credential, signing and relay adapters. Provider-confirmed largeBlob storage avoids relay access; unsupported providers can use explicitly approved relay recovery. See the [protocol, adapter contracts and recovery examples](../../docs/passkey-recovery.md). `encryptRecoveryPayload`, `decryptRecoveryPayload`, event builders and validators are also exported for hosts that own their own flow. These are the legacy keytr formats. New passkeys use tagged handles and the proposal's stored record format (`saveStoredRecord`, with `key`, `seed` and `vault` payloads), and `resolvePasskeyIdentity` logs in with either mode; see [telling the modes apart](../../docs/passkey-recovery.md#telling-the-modes-apart).
