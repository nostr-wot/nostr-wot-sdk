# Passkey recovery for applications

The `@nostr-wot/vault` recovery APIs support a single private key, a seed payload, or a complete vault snapshot. Full-vault recovery is the recommended default for an app that manages multiple accounts. Recovery is separate from event archives and from the password-only `Vault` class lifecycle.

## Platform boundary

The package contains portable crypto, event envelopes, validation and recovery orchestration. It makes no native authenticator calls, owns no sockets and imports no UI framework. A host supplies `RecoveryProvider`, `RecoveryTransport`, a signing function and a signature verifier. The browser extension can adapt its WebAuthn client and pooled relay transport; a native app can adapt its platform credential provider and existing relay manager. Do not open another relay pool just for recovery when the app already owns one.

New passkeys default to `passkeys.nostrwot.com`. Existing wrappers without an explicit RP retain `passkeys.nostr-wot.com` in their authenticated binding. Newly wrapped credentials store their RP individually, allowing mixed old/new/custom enrollments. An outer enrollment's RP identifies its first wrapper and must agree with it. Choosing another RP does not grant access to it: browsers and native providers must authorize the host to use that RP. Changing RP requires a new credential; a registered credential cannot be moved.

## Recovery scopes and wire format

| Scope | Protocol | Payload | Address |
|---|---|---|---|
| `private-key` | Keytr PRF v1 | Exactly 32 raw private-key bytes | Credential ID in base64url |
| `seed` | Typed PRF v4 proposal | Application-serialized seed and derivation information | `<credential>:seed:<schema>` |
| `vault` | Typed PRF v4 proposal | Application-serialized complete vault or encrypted snapshot | `<credential>:vault:<schema>` |

All events use kind 31777. Typed scopes use a separate addressable coordinate so they cannot replace a private-key event for the same credential. The default schema identifiers are `com.nostrwot.seed.v1` and `com.nostrwot.vault.v1`; applications may select a different explicit versioned schema. Sharing a type label or cipher does not make schemas interchangeable. Typed v4 is a proposal coordinated with Keytr, not a claim that deployed v1-only clients can restore vaults. The existing v1 codec remains byte-compatible, subject to the same credential/RP access and discovery metadata.

The PRF evaluation input is UTF-8 `keytr-v1`. Newly discoverable credentials store the event author's 32 raw public-key bytes in the user handle. That public value locates the relay event without asking the user for an npub. The account author must remain available to sign updated snapshots. Do not reinterpret existing random user handles as this recovery identity; enroll a compatible credential explicitly.

Both codecs use HKDF-SHA256, a fresh 32-byte salt, AES-256-GCM, a fresh 12-byte IV and a 16-byte authentication tag. The binary layout is `version(1) | IV(12) | salt(32) | ciphertext(N+16)`, encoded as canonical standard base64. The v1 HKDF context is `keytr nsec encryption v1`, with AAD `UTF8("keytr") | 0x01 | rawCredentialId`. The v4 context is `keytr payload encryption v4`, with AAD equal to UTF-8 compact JSON `['keytr',4,type,schema,rpId,authorHex,credentialBase64url]`. JSON uses double quotes, no extra whitespace, lowercase hex and the reference implementation's padded base64url encoding. Payloads are limited to 64 KiB; v1 additionally requires exactly 32 bytes. KiH and password-derived relay encryption are unsupported.

Required event tags are `d`, `rp`, `algo=aes-256-gcm`, `kdf=hkdf-sha256` and `v`. Typed events also require `credential`, `type` and `schema`. Validators reject missing/duplicate required tags, unexpected identity/context, unsupported algorithms or versions, malformed encoding, oversized data and invalid signatures. Type is explicit and authenticated; do not guess it from decrypted byte length. Hosts must verify that a recovered private key or seed derives the expected author and validate the entire application schema before importing any account.

## Adapter usage

```ts
import {
  saveRecovery, restoreRecovery, serializePasskeyBackup,
  type RecoveryProvider, type RecoveryTransport,
} from '@nostr-wot/vault';

// Implement these using your existing native/browser credential and relay clients.
const provider: RecoveryProvider = myPasskeyAdapter;
const transport: RecoveryTransport = myRelayAdapter;
const context = {
  credentialId: enrolled.credentialId, // canonical standard base64
  rpId: enrolled.rpId,
  pubkey: recoveryAuthor,
  scope: 'vault' as const,
};
const payload = new TextEncoder().encode(serializePasskeyBackup(record));
try {
  const result = await saveRecovery({
    context, payload, provider, transport,
    largeBlobSupported: enrolled.largeBlobSupported,
    allowRelay: userApprovedRelayStorage,
    relays: configuredRecoveryRelays,
    sign: signWithRecoveryAuthor,
    verify: verifyNostrEvent,
    assertSession: assertCurrentVaultSession,
    // Optional prf: caller-owned 32-byte registration result, reused to avoid another prompt.
  });
  // Only now mark recovery saved. result.acceptedRelays records partial publication.
} finally {
  payload.fill(0);
}

const recovered = await restoreRecovery({
  rpId: context.rpId, provider, transport,
  relays: configuredRecoveryRelays,
  verify: verifyNostrEvent,
  // Optional scope/schema restrict recovery; otherwise explicit event tags select them.
});
try {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(recovered.payload);
  await validateAndImportApplicationPayload(text, recovered.context);
} finally {
  recovered.payload.fill(0);
}
```

`RecoveryProvider.authenticate` receives credential ID, RP and PRF input and returns the 32-byte output after user verification. The orchestration functions clear returned provider buffers on success and failure. An optional `saveRecovery.prf` remains caller-owned and must be cleared by the caller. `discover` returns the selected credential's ID, its public user handle as lowercase hex, and any attached blob. `writeBlob` targets exactly that credential and RP and returns true only after provider-confirmed storage. Cancellation and other native errors must reject rather than return a false success.

`RecoveryTransport` reuses the host's connections. Its queries must honor the supplied filter, bound network frames and return at most the requested count. Its publish method returns true only after the relay acknowledges the signed event as accepted/already stored. Both methods receive an abort signal; publishing also receives the host session assertion to check immediately before the actual network send. The SDK bounds each relay operation to at most 30 seconds, contacts selected relays concurrently and cancels leases on completion. Hosts retain responsibility for relay URL policy, authentication consent, worker lifetime and any platform networking restrictions.

## Provider storage and relay fallback

Where largeBlob is supported, the SDK stores a versioned `nostr-wot-passkey-recovery` envelope containing the signed encrypted event. A confirmed write completes without contacting relays. This removes the relay dependency for recovery as long as the chosen provider makes the credential and blob available on the destination device. A local write is not proof of cross-device synchronization. The provider envelope is bounded to 128 KiB; providers may have smaller quotas and should reject writes they cannot persist.

If largeBlob is unsupported, relay publication requires `allowRelay: true`, based on the user's explicit choice. No relay publication follows a cancelled assertion, refused blob write or unconfirmed write. The app may offer an explicit retry, relay save or file export after explaining the failure. At least one acknowledgement is required for relay success, and the result exposes accepted destinations. A relay acknowledgement does not guarantee permanent retention.

Fresh-device relay restore needs known bootstrap recovery relays, since profile/vault settings are not yet available. The SDK intentionally ships no hidden relay list. Apps must use the same documented recovery destinations during enrollment and restore, and offer a relay override or file recovery if those destinations cannot be reached. Restoration validates signatures/context before the targeted PRF request and selects the newest valid matching event across results. A newer authenticated event that cannot decrypt fails; it never silently rolls back to an older snapshot. Withholding relays can still serve stale snapshots on a fresh installation.

## Host responsibilities

Recovery payloads are snapshots. Refresh them after account/enrollment changes and display stale recovery status if an update fails. Restore through the app's normal account import and vault replacement safeguards. A seed payload excludes separately imported keys and independent credentials unless the application's schema explicitly includes them. A full-vault snapshot may include multiple identities, wallet secrets and remote-signer material; explain its scope accurately.

Public relay metadata includes author, credential identifier, RP, type, schema, size and timing. Relays also observe queries. Updates and deletion requests cannot erase older copied ciphertext. Changing the local unlock method or removing accounts does not revoke an old snapshot. Only ciphertext belongs in events or largeBlob; never log PRF output, encryption keys or plaintext. PRF output reaches trusted host code, and JavaScript cannot guarantee erasure of strings or all copies.

The extension's older `nostr-wot-passkey-vault` largeBlob format is a complete encrypted vault record rather than this signed-event envelope. Keep its existing parser as a migration path; `restoreRecovery` rejects unknown blob formats instead of silently treating malformed data as permission to query relays. Real Apple/Google provider synchronization and native adapters require integration tests on their respective devices; protocol fixtures alone do not certify them.
