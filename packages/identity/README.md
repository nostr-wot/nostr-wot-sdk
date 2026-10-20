# @nostr-wot/identity

Build the account and approval boundary of a Nostr signer. This package owns seed derivation, portable encrypted vaults, permission records, the signing pipeline and the NIP-46 responder. Use it in an extension, mobile signer or server that controls accounts. Applications that only request signatures should use `nostr-wot-sdk/signers`.

> Identity package: these entry points replace accounts, vault, permissions, signer-core and bunker packages in the consolidation release. Publish this replacement before deprecating the old npm names. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

## Install

```bash
npm install @nostr-wot/identity nostr-wot-sdk nostr-tools
```

Use ESM imports. Import explicit subpaths to identify the boundary you are using; `@nostr-wot/identity/vault` is an import path, not a separate package to install.

## Entry points

| Import | Use case and detailed guide |
| --- | --- |
| `@nostr-wot/identity/accounts` | [Generate/import accounts, derive NIP-06 keys, classify imported material, and encrypt/decrypt NIP-49 keys](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/accounts/README.md). |
| `@nostr-wot/identity/vault` | [Password vault lifecycle, scoped secret access, passkey records and recovery](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/vault/README.md). |
| `@nostr-wot/identity/permissions` | [Caller and method rules, site scopes and destination-specific authentication grants](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/permissions/README.md). |
| `@nostr-wot/identity/signing` | [Authorize requests, request approval/unlock, sign locally or delegate to a remote signer, and report typed errors](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/signer-core/README.md). |
| `@nostr-wot/identity/bunker` | [Serve NIP-46 clients over NIP-44 encrypted relay transport](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/bunker/README.md). |

## Recognize imported account material

```ts
import { detectImportKind, generateMnemonic, validateMnemonic } from '@nostr-wot/identity/accounts';

const mnemonic = generateMnemonic();
if (!validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic');
const kind = detectImportKind(mnemonic);
```

Generating or parsing an account does not persist it, authorize requests or display a backup flow. The host supplies those decisions. Never log a mnemonic or private key. The account guide documents accepted input, derivation paths and import errors.

## Compose a signer host

Use a persistent `KeyValueStore` from your host with the vault and permission store; `nostr-wot-sdk/storage` supplies the interface, a namespacing wrapper and an in-memory implementation for tests. Give `SignerCore` the vault, permissions, approval UI and any remote-signing or unlock ports your host supports. Route verified transport requests to it. A NIP-46 `BunkerServer` receives and decrypts requests, but its injected handler remains responsible for authorization.

A deny rule ends a signing request before approval. The core pins the account and rechecks authorization around asynchronous boundaries. Batch results report each item's success or failure; do not treat a partially successful batch as if nothing was signed. When composing with the bunker, use `handlerTimeoutMs: 0` so the signing pipeline owns request timeouts.

## Vault and passkey responsibilities

The password vault uses PBKDF2-HMAC-SHA-256 and AES-256-GCM with an existing versioned record format. An empty password provides no secrecy against someone holding the stored record. Secret accessors give callbacks temporary byte copies and invalidate results after revocation; callbacks must not publish or otherwise externalize secrets or results before authorization completes. The host owns storage durability, unlock UI and lock/session lifetime.

Passkey version 2 records use separate helpers; do not pass them to the password-only `Vault.unlock()`. The host performs WebAuthn registration/assertions, obtains PRF output, verifies the user and coordinates mutations. Recovery is not automatically a relay upload: provider-confirmed storage and explicit fallback behavior are described in the [passkey recovery guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/passkey-recovery.md).

## Authentication is destination-specific

NIP-42 and NIP-98 signing is credential issuance. A broad event-kind allow is insufficient. Supply transport-attested requester identity and display the parsed destination and method in approval UI. Web requesters require one-time consent by default; remembered grants are explicit policy. Malformed destinations, revoked permissions, changed accounts and stale requests fail rather than bypass approval. See the signing guide for `AuthenticationPolicy`, remembered grants and the host-only relay login path.

## Runtime requirements

Portable account, vault, permission and signing code does not depend on the DOM or WebExtension APIs. Hosts supply storage, clocks where configurable, approval and transport adapters. Required globals include `TextEncoder`, `TextDecoder`, secure `crypto.getRandomValues`, timers and `AbortController`. Post-quantum paths also need base64 support (`atob`/`btoa`, or the supported Buffer fallback). React Native/Hermes hosts must install the appropriate polyfills before loading the modules, including secure randomness; do not substitute a non-cryptographic random source.

The portable vault's cryptography does not require `crypto.subtle`. Browser WebAuthn and provider adapters still require their documented platform capabilities. A relay responder also needs a compatible WebSocket transport. Import only the entry point appropriate to your runtime.

## License

GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
