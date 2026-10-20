# @nostr-wot/identity

## 1.0.0

### Added

- Introduce the maintained signer-host package with explicit `/accounts`, `/vault`, `/permissions`, `/signing` and `/bunker` entry points. Move the existing implementations here and retain compatibility wrappers under their previous package names.
- Preserve account derivation/import behavior, password and passkey record formats, scoped secret access, permission rules, approval/revocation checks and NIP-46 responder behavior. Portable modules remain separate from the relay-backed bunker transport.
- Publish identity entry points as ESM only and require `@noble/hashes` 2.4.0 or newer so password derivation yields to the host event loop.
