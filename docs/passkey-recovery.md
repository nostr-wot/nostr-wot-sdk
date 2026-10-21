# Passkey recovery for applications

The `@nostr-wot/identity/vault` passkey APIs follow the [passkey key modes proposal](https://github.com/nostr-wot/nostr-wot-extension/blob/main/nips/passkey/01-passkey-key-modes.md). A passkey holds a Nostr identity in one of two modes:

- **Derived**: the passkey is the key. The private key is computed from the PRF output on every login and kept nowhere.
- **Stored**: the passkey is the lock on the key. The secret (a private key, a seed, or a seed with accounts) is encrypted under the PRF output and kept in the passkey's largeBlob, on relays or in a file.

Stored mode is recommended: the identity outlives any single passkey and can be protected again under another RP. Passkeys created before the proposal use the [legacy records](#legacy-records) at the end of this guide.

The package holds portable crypto, record formats, validation and orchestration. It makes no authenticator calls and owns no sockets. A host supplies a `RecoveryProvider` (its WebAuthn or native credential client), a `RecoveryTransport` (its existing relay connections), a signing function and a signature verifier. Deployment specifics such as RP IDs, registry parameter sets and gateways are host configuration; the protocol code names none.

## Relying parties

A passkey only works under the RP ID it was created for, and its PRF outputs belong to it. Another application can ask for it only if that RP allows it (`/.well-known/webauthn`, `apple-app-site-association`, `assetlinks.json`, or an extension host permission). Every allowed client can obtain the secret once the user unlocks the passkey, so an allowlist entry is a trust decision, not a setting.

### Own RP and one-time import (default)

Each application creates passkeys under its own RP and offers one sign-in action for them. Do not ask users to pick an RP at every sign-in: a browser does not say whether passkeys exist for an RP, so silent fallback between RPs is impossible.

To bring an identity from another application, do it once: read it from the source RP, show the public key for the user to confirm, then protect it with a new stored passkey under your own RP. Later sign-ins use only your RP.

```ts
// The source RP must allow this application. Pass its parameter set if it uses a registry one.
const source = await resolvePasskeyIdentity({ rpId: sourceRpId, provider, transport, relays, verify, parameterSet: sourceSet });
let payload: StoredPayload | undefined;
let author: string | undefined;
if (source.mode === 'derived') { payload = { type: 'key', key: source.secret }; author = source.pubkey; }
else if (source.mode === 'stored' && source.format === 'npk1') { payload = source.payload; author = source.author; }
// 'ambiguous': confirm, then derivePasskeyIdentity. Legacy formats: import through your own schema.
let prf: Uint8Array | undefined;
try {
  if (!payload || !author || !await userConfirmsAccount(author)) return;
  // Your WebAuthn create() under your RP, user.id = encodeStoredHandle(author), PRF input storedPrfInput().
  const created = await createPasskey({ rpId: ownRpId, userId: encodeStoredHandle(author), prfInput: storedPrfInput() });
  prf = created.prf;
  await saveStoredRecord({
    payload, prf, provider, transport, relays, sign, verify,
    context: { credentialId: created.credentialId, rpId: ownRpId, author },
    largeBlobSupported: created.largeBlobSupported, allowRelay: userApprovedRelayStorage,
  });
} finally {
  if (payload?.type === 'key') payload.key.fill(0);
  prf?.fill(0);
}
```

If the source RP does not allow your application, the user can still move the identity through an export the source offers: a seed, a private key or a stored record file (`openStoredRecord`).

### Shared gateways (optional)

A gateway is a domain used only as an RP ID by several applications, so one passkey signs in to all of them without an import. It serves the `.well-known` files for its members, publishes its member list and policy, has at most 5 member domains (the browser limit), and is listed in the [registry](https://github.com/nostr-wot/nostr-wot-extension/blob/main/nips/passkey/02-passkey-registry.md#shared-gateways). Using one is just passing its RP ID as `rpId`. Prefer stored mode on a gateway: a derived key there can be reproduced by every member, and leaving means a new identity.

## Telling the modes apart

The user handle (`user.id`) declares the mode, because it is visible before any PRF evaluation or storage read. New passkeys get a tagged handle: `encodeDerivedHandle(set)` (22 bytes) or `encodeStoredHandle(author)` (37 bytes). `classifyPasskeyHandle(bytes)` returns, in the proposal's order:

- `derived`, with the parameter set byte. A set the host does not implement is refused.
- `stored`, with the author, for a tagged stored handle.
- `stored` with `legacy: 'raw-pubkey'` and `confirmRecord: true`, for any 32-byte handle, even one starting with `NPK`. It only counts as stored once a legacy record for that author is found; otherwise it is unknown.
- `stored` with `legacy: 'key-in-handle'`, for a 33-byte handle starting `0x03`. Refused.
- `unsupported`, for any other handle starting with `NPK`. Refused, with no derivation and no discovery.
- `unknown`, for anything else, including no handle.

A passkey is used in one mode only: never derive a key from a stored passkey, and never write a stored record for a derived one.

## Derived mode

```
prf_input = SHA-256(UTF-8(salt_label))
secret    = HKDF-SHA256(ikm = PRF(prf_input), salt = prf_input, info = UTF-8(info_label), length = 32)
```

A `DerivedParameterSet` is `{ id, saltLabel, infoLabel }`. The package ships only the proposal's default, `DEFAULT_DERIVED_PARAMETER_SET` (`0x01`). Sets `0x02` to `0x7f` are assigned in the registry; a host that needs one passes it as configuration, and `0x01` cannot be redefined. `deriveNostrKey(prfOutput, set)` returns `{ secret, pubkey }` and fails, without retrying, on a zero or out-of-range scalar. The caller zeroes `secret`.

## Stored mode

| Type | Byte | Contents | Author |
|---|---|---|---|
| `key` | `0x01` | Exactly 32 bytes, the private key | Its public key |
| `seed` | `0x02` | JSON `{ "entropy": "<hex>", "passphrase": "<optional>" }` | The seed's key at `m/44'/1237'/0'/0/0` |
| `vault` | `0x03` | JSON with an optional `seed`, a non-empty `accounts` list and optional `ext` | Any account in the vault |

Seed entropy is 16, 20, 24, 28 or 32 bytes of lowercase hex. Keys come from the English BIP-39 mnemonic of that entropy with the passphrase (`storedSeedKey(seed, path)`). A `seed` record promises only its main account; use `vault` to restore exact accounts.

A vault account is `{ "kind": "derived", "path": "m/44'/1237'/0'/0/3" }`, which needs the vault's seed, or `{ "kind": "key", "secret": "<hex>" }`. Either may carry a `label` and `default: true` (at most one account). A derived path is the full canonical BIP-32 path under `m/44'/1237'/`, derived exactly, never inferred from position. Accounts of an unknown `kind`, unknown fields and unknown `ext` namespaces are kept unchanged when a vault is written again. Plaintext is limited to 65,536 bytes.

`storedPayloadKeys(payload)` lists the importable identities: the key, the seed's main account, or each vault account of a known kind, with `pubkey`, `secret`, `label` and `default`. Use a single one directly; for several, let the user choose with the `default` one preselected. Zero every `secret`.

The record is `NPK | 0x01 | type | IV(12) | salt(32) | AES-256-GCM ciphertext and tag`, keyed by HKDF over the PRF output for `storedPrfInput()`. The AAD binds type, RP ID, author and credential ID, so a record cannot be moved to another passkey, site or identity, or read as another type.

- `encryptStoredRecord(payload, prf, context)` checks that the author is one of the payload's keys and returns the record bytes, also usable as a file backup.
- `openStoredRecord(record, prf, context)` decrypts, validates and checks the author before returning the payload.
- `saveStoredRecord` encrypts and stores. With largeBlob support the blob holds the raw record. A refused, failed or unconfirmed write rejects and never falls through to relays. Relay storage needs `allowRelay: true` and at least one acknowledgement; the event is kind 31777 by the author, tagged `d` = `<credential>:<type>`, `credential`, `v` = `npk1`, `rp` and `type`.

## Logging in

`resolvePasskeyIdentity` runs one discoverable assertion that asks for the stored input as `prf.eval.first`, the derived input as `second` and a largeBlob read, classifies the handle and returns one of:

- `derived`: `{ pubkey, secret, parameterSet }`. The caller zeroes `secret`.
- `stored` with `format: 'npk1'`: the payload and its checked author. The caller zeroes a `key` payload.
- `stored` with `format: 'legacy'`: `{ payload, context, event }` as `restoreRecovery` returns it, or, with `source: 'passkey-vault'`, a largeBlob vault envelope for `openPasskeyRecord`.
- `ambiguous`: `{ pubkey, parameterSet }` and no secret. Show the public key and ask the user; only after a yes call `derivePasskeyIdentity`, which reproduces exactly that candidate.
- `error`: `missing-record`, `undecryptable-record`, `author-mismatch`, `unreadable-record`, `unsupported-handle`, `prf-unavailable` or `invalid-assertion`. Cancellation and provider failures reject.

Options: `parameterSet` is the set this RP is known to use. It is evaluated as `second`, a tagged handle naming it is implemented, and an unknown handle with no record resolves as derived with it. `isKnownDerived` lets the host recognise its own record linking a credential to a derived public key. Without either, an unknown handle with no record is `ambiguous`, because an unreachable relay looks the same as a passkey with no record.

Stored records are read from the blob first, then relays by author (tagged handles) or by `#credential` and `#d` (unknown handles). Each author's newest valid event wins, a stranger's record cannot shadow the real one, and a newer authenticated record that does not decrypt is an error, never a rollback. A tagged-format blob on an untagged passkey is `unreadable-record`: it cannot be opened without the author, and it is never derived instead.

### Provider contract

The additions are optional, so existing adapters keep compiling. `discover` may receive `prf: { first, second }` and `largeBlob: true`, and may return `userHandle` bytes and `prf` outputs. Returning no `prf` at all tells the SDK the platform dropped the extensions; it then runs one targeted assertion asking only for what the handle needs, through the optional `assert({ rpId, credentialId, prf, largeBlob })`, or `authenticate` one input at a time. The SDK zeroes every PRF output a provider returns. `RecoveryTransport.query` filters can carry `#d` or `#credential` instead of `authors`; every event is still checked against the credential before use.

To move a derived identity to stored mode, register a new passkey with `encodeStoredHandle(pubkey)` and save the key with `saveStoredRecord`. The old passkey keeps producing the same key until the user removes it from their provider.

## Legacy records

`saveRecovery` and `restoreRecovery` implement the formats of passkeys created before the proposal, with a 32-byte handle holding the author's public key:

| Scope | Protocol | Payload | Address |
|---|---|---|---|
| `private-key` | NIP-K1 v1 | Exactly 32 raw private-key bytes | Credential ID in base64url |
| `seed` | Typed v4 proposal | Application-serialized seed | `<credential>:seed:<schema>` |
| `vault` | Typed v4 proposal | Application-serialized vault or encrypted snapshot | `<credential>:vault:<schema>` |

All events use kind 31777, and the PRF input is UTF-8 `keytr-v1`, used as is. Both codecs use HKDF-SHA256, a fresh 32-byte salt, AES-256-GCM and a fresh 12-byte IV; the layout is `version(1) | IV(12) | salt(32) | ciphertext(N+16)` in canonical base64. The v1 context is `keytr nsec encryption v1` with AAD `UTF8("keytr") | 0x01 | rawCredentialId`; v4 uses `keytr payload encryption v4` with AAD the compact JSON `['keytr',4,type,schema,rpId,authorHex,credentialBase64url]`. The default schemas are `com.nostrwot.seed.v1` and `com.nostrwot.vault.v1`; a host may select another explicit versioned schema and must only import a schema it knows. Required tags are `d`, `rp`, `algo=aes-256-gcm`, `kdf=hkdf-sha256` and `v`, plus `credential`, `type` and `schema` for v4.

`restoreRecovery` classifies the handle first. It refuses derived, tagged stored, unsupported and key-in-handle passkeys, and looks an untagged credential (or a 32-byte handle with no record by that author) up by credential ID.

```ts
const context = { credentialId: enrolled.credentialId, rpId: enrolled.rpId, pubkey: recoveryAuthor, scope: 'vault' as const };
const payload = new TextEncoder().encode(serializePasskeyBackup(record));
try {
  const result = await saveRecovery({
    context, payload, provider, transport, relays, sign, verify,
    largeBlobSupported: enrolled.largeBlobSupported,
    allowRelay: userApprovedRelayStorage,
    assertSession: assertCurrentVaultSession,
  });
  // Only now mark recovery saved. result.acceptedRelays records partial publication.
} finally {
  payload.fill(0);
}

const recovered = await restoreRecovery({ rpId: context.rpId, provider, transport, relays, verify });
try {
  await validateAndImportApplicationPayload(recovered.payload, recovered.context);
} finally {
  recovered.payload.fill(0);
}
```

With largeBlob support the SDK stores a versioned `nostr-wot-passkey-recovery` envelope holding the signed event, bounded to 128 KiB. A confirmed write completes without relays; a local write is not proof of cross-device synchronization. Without largeBlob, relay publication needs `allowRelay: true` and at least one acknowledgement.

The package also contains vault helpers whose new credentials default to `passkeys.nostrwot.com`, while older wrappers without an explicit RP keep `passkeys.nostr-wot.com` in their binding. Their largeBlob format, `nostr-wot-passkey-vault`, is a complete encrypted vault record rather than a signed event; `resolvePasskeyIdentity` hands it back for `openPasskeyRecord`.

## Host responsibilities

- `RecoveryProvider.authenticate` returns the 32-byte PRF output after user verification, `writeBlob` returns true only after provider-confirmed storage, and cancellation must reject rather than return a false success.
- `RecoveryTransport` reuses the host's connections, honours filters, bounds frames and returns true from `publish` only on acknowledgement. The SDK bounds each relay call to 30 seconds and ships no relay list: use the same documented recovery relays at enrollment and restore, and offer an override or file recovery.
- Records are snapshots. Refresh them after account changes and show stale status if an update fails. A vault may hold many identities; tell the user what a record contains before saving it.
- Relay records reveal author, credential ID, RP, type, size and timing, and old ciphertext cannot be erased. Never log PRF output, keys or plaintext. JavaScript cannot guarantee erasure of every copy.
- Real provider synchronization and native adapters need device integration tests; protocol fixtures alone do not certify them.
