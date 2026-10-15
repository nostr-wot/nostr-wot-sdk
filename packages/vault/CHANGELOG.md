# @nostr-wot/vault

## Unreleased

- Add portable single-key, seed and vault recovery codecs, authenticated events, provider-first storage and explicit relay fallback through host adapters. New passkeys default to passkeys.nostrwot.com while preserving old and custom RP bindings.

## 1.0.0

### Major Changes

- [#16](https://github.com/nostr-wot/nostr-wot-sdk/pull/16) [`c609a4b`](https://github.com/nostr-wot/nostr-wot-sdk/commit/c609a4b64d7cb44173472eef919a602065476d8a) Thanks [@leonacostaok](https://github.com/leonacostaok)! - License project-owned code under GNU General Public License version 3 only (GPL-3.0-only). Include the full license and preserved prior MIT notice in every package. Previously released versions keep their original license.

### Patch Changes

- Updated dependencies [[`c609a4b`](https://github.com/nostr-wot/nostr-wot-sdk/commit/c609a4b64d7cb44173472eef919a602065476d8a)]:
  - @nostr-wot/accounts@1.0.0
  - @nostr-wot/storage@1.0.0

## 0.3.0

### Minor Changes

- [#14](https://github.com/nostr-wot/nostr-wot-sdk/pull/14) [`3f866fa`](https://github.com/nostr-wot/nostr-wot-sdk/commit/3f866fa3192e1870bf202ec7714af0f438ee32e7) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add portable version 2 passkey vault records, bounded recovery-file parsing, and interoperable HKDF/AES-GCM wrapping with scoped key access. Keep password vault records compatible, reject unsupported protection modes, and retain passkey enrollment during password saves and changes.

  Add memory-only active-account clearing with scoped-capability revocation, serialized cleanup that deletes only an authenticated empty vault, and seed-relationship removal warnings that never expose seed material.

## 0.2.0

### Minor Changes

- [`78f4aa2`](https://github.com/nostr-wot/nostr-wot-sdk/commit/78f4aa2e91e96e4ae5ed8fc32ec900813bf724fc) Thanks [@leonacostaok](https://github.com/leonacostaok)! - `hasMnemonic(accountId)`: whether an account holds a seed phrase, false while locked, revealing nothing, as `hasImportedPqKeys` does.

  `withDerivedSecrets(secrets, fn)`: the scoped accessor for a secret the vault never stored — keys a caller derived from a mnemonic it does hold. The buffers are registered in the same live-key set `withPrivkey`'s copy goes in, so one `lock()` zeroes them mid-callback rather than whenever the callback happens to finish, and a result computed under a session that moved is voided.

### Patch Changes

- Updated dependencies [[`2bf5a21`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2bf5a21cc9ff2c091b3d5357fc8904e6ab11aebc), [`02a88b6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/02a88b6a717773751d0b850571dbff0921a68acf), [`f984cb6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/f984cb65f965456503a8627ffa6dc9c3e55f028c), [`302f897`](https://github.com/nostr-wot/nostr-wot-sdk/commit/302f897e5e1bc854ef5ad8a07433b15c513ea996)]:
  - @nostr-wot/accounts@0.1.1
  - @nostr-wot/storage@0.2.0
