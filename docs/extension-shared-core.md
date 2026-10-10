# Extension shared-core integration

The extension owns browser state, UI and transport attestation. The SDK owns portable cryptography, account records, permission resolution and signing contracts. An adapter must preserve existing storage keys, account identities and authorization decisions; replacing imports alone is not a migration.

## Package boundaries

| Package | Reusable behavior | Extension-owned adapter |
| --- | --- | --- |
| `@nostr-wot/storage` | Key/value store contract and namespaces | Map the existing browser storage area without renaming deployed keys. |
| `@nostr-wot/accounts` | NIP-06 derivation, NIP-19/NIP-49 and safe account projection | Wallet-specific metadata, profile UI and account selection presentation. |
| `@nostr-wot/permissions` | Global/site inheritance, conservative migrations, destination grants and backend opt-in | Supply account/site inventory, trusted registry pairs, connection checks and settings UI. |
| `@nostr-wot/vault` | Password vault lifecycle, scoped secrets, passkey record encryption and recovery parsing | WebAuthn/provider selection, automatic-unlock presentation, passkey lifecycle orchestration and storage transactions. |
| `@nostr-wot/signer-core` | Request snapshots, permission checks, individual authentication disclosure, signing and remote-result verification | Browser/frame attestation, connected-site policy, privileged endpoints, approval UI and destination-grant persistence. |
| `@nostr-wot/signers` | NIP-46 pairing, identity reads and owned transport disposal | Account-scoped client cache and revocation on account or vault changes. |
| `@nostr-wot/pq` | Hybrid encryption and post-quantum attestations | Native approval and public profile presentation. |

## Rules and authentication

Run legacy migrations with `Permissions.migrate()`, then use `migrateToGlobalRules({ accountIds, origins })` with the complete host account inventory and connected origins, including sites that have no saved bucket. The migration journal makes interrupted writes retryable; reads fail closed while a journal remains. Existing account/site decisions, including absence of permission, survive consolidation. `getForOrigin` returns effective rules; `getAllRaw` supplies stored layers for inherited-versus-overridden UI. `inheritRule`, `clearRuleBucket` and `resetAccountRules` alter ordinary rules without treating destination grants as generic kind permissions.

`AuthenticationGrants` preserves account/site/destination scoping, exact HTTP endpoints and denial precedence. Backend automation is off until explicitly enabled for an account. Its registry is injected by the host; exact same-origin or configured site/backend pairs may then qualify. The host must establish that the requesting site is connected and enforce privileged native-wallet endpoints independently of registry matching. Neither a registry entry nor a global signing rule establishes that a request came from the claimed site.

`SignerCore` validates authentication tags, timestamps and destination schemes before approval, and revalidates before releasing the signed result. Approval adapters receive protocol, URL and method in the third argument and must explicitly return `authenticationScope: 'once'`. They can consult destination grants before deciding whether to display a prompt, but must also recheck grant and connection revocation through `authentication.assertAllowed`. Generic batches cannot carry authentication; send those requests individually. Non-web transports need a trusted `authentication.originFor` resolver instead of claiming a website through event metadata.

Legacy domain/challenge login is an explicit host allowlist, empty by default. It is classified separately, requires a visible nonstandard-format warning, and never creates an ordinary allow or denial rule. The library does not contain a particular client's exemption. See the extension's `src/domain/signing/authentication.ts` and `src/services/signing/signer.ts` for its browser-side implementation.

## Passkey vault compatibility

Password records retain their version-1 shape, and `Vault` remains the password-session implementation. Passkey version-2 records use the extension's PRF/HKDF wrapping and credential-bound AES-GCM format. `createPasskeyRecord`, `openPasskeyRecord`, `sealPasskeyPayload`, `withPasskeyVaultKey` and the backup parser provide a complete portable record pipeline. They do not turn the password `Vault` class into a browser passkey session; the host must orchestrate enrollment, protection switching, concurrent writes and session revocation. Password saves preserve dormant `registeredPasskeys` metadata.

The passkey record format currently binds to the extension's RP identifier. Cross-provider synchronization and WebAuthn largeBlob availability are browser/provider capabilities, not guarantees of the encryption library. The host must keep its verified-write/file-fallback flow and preserve the private-cache key when changing protection. WebCrypto interoperability tests verify the cryptographic format, not real-device synchronization.

The SDK's `withCacheKey` supplies scoped bytes; the extension uses a non-extractable WebCrypto key. An adapter can import the bytes inside the scope, but must preserve revocation checks and avoid retaining the imported key beyond that scope. Keep scoped private-key access rather than reintroducing a raw private-key getter to satisfy old tests. `clearActiveAccount` revokes the in-memory account selection; `destroyIfEmpty` requires authenticated empty contents and serializes deletion with mutations.

## Integration checks

Use published npm packages when integrating the extension. Do not restore the archived migration's `file:vendor/*.tgz` dependencies: those packages predate current rules, startup behavior and passkeys. Every required package now has a public npm release, but consumers need versions containing the APIs they adopt, not merely the existence of an older release.

Exercise existing password and passkey records, interrupted permission migrations, shared/site denial precedence, account changes during approval, remote-event verification, private-cache access and empty-vault cleanup against the adapter. Run the extension's complete tests and disposable-browser passkey/archive flows from the integrated build. Archive storage, event browsing and browser startup performance remain extension features; this package refresh does not move them into the SDK or change the locally loaded extension.
