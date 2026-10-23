# @nostr-wot/identity

## 1.1.0-next.1

### Patch Changes

- [#21](https://github.com/nostr-wot/nostr-wot-sdk/pull/21) [`482daeb`](https://github.com/nostr-wot/nostr-wot-sdk/commit/482daeb4eca189d64d89cc04d335b29114c12ea5) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Allow stored passkey records bound to localhost for WebAuthn development, while retaining exact RP binding and rejecting origins or port-bearing values.

## 1.1.0-next.0

### Minor Changes

- [#19](https://github.com/nostr-wot/nostr-wot-sdk/pull/19) [`5ed0b56`](https://github.com/nostr-wot/nostr-wot-sdk/commit/5ed0b569c1a685a6f096bebd42362039ae2a6096) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Support derived and stored passkeys as defined by the passkey key modes proposal: derived keys from host-configured parameter sets (`deriveNostrKey`), tagged user handles (`classifyPasskeyHandle`), stored `key`, `seed` and `vault` records (`encryptStoredRecord`, `openStoredRecord`, `saveStoredRecord`, `storedPayloadKeys`), and `resolvePasskeyIdentity`, which never derives a key from a stored passkey and returns `ambiguous` when nothing proves the mode. `restoreRecovery` now classifies the user handle instead of reading it as a public key, and finds untagged credentials by credential ID. Provider and transport additions are optional.

### Patch Changes

- [#19](https://github.com/nostr-wot/nostr-wot-sdk/pull/19) [`5ed0b56`](https://github.com/nostr-wot/nostr-wot-sdk/commit/5ed0b569c1a685a6f096bebd42362039ae2a6096) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Keep signed new-format vaults eligible regardless of unrelated tag sizes so malformed newest records cannot silently fall back to older vaults. Require a provider storage read and explicit overwrite confirmation for nonempty passkey blobs. Release the passkey changes on the `next` prerelease channel while cross-client and real-device acceptance remain pending.

- [#19](https://github.com/nostr-wot/nostr-wot-sdk/pull/19) [`5ed0b56`](https://github.com/nostr-wot/nostr-wot-sdk/commit/5ed0b569c1a685a6f096bebd42362039ae2a6096) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Align tagged passkey recovery with the split key/vault proposal: use provisional kind 31778 without a version tag for new records, normalize seed writes to vaults, and preserve legacy reads. Validate strict vault JSON, skip unusable accounts, select the first usable default, compare provider and newest relay vault timestamps, and report source failures through an optional recovery callback. Credential-specific relay queries and conservative handle recovery prevent unrelated records or missing recovery data from selecting a different identity.

## 1.0.0

### Added

- Introduce the maintained signer-host package with explicit `/accounts`, `/vault`, `/permissions`, `/signing` and `/bunker` entry points. Move the existing implementations here and retain compatibility wrappers under their previous package names.
- Preserve account derivation/import behavior, password and passkey record formats, scoped secret access, permission rules, approval/revocation checks and NIP-46 responder behavior. Portable modules remain separate from the relay-backed bunker transport.
- Publish identity entry points as ESM only and require `@noble/hashes` 2.4.0 or newer so password derivation yields to the host event loop.
