# @nostr-wot/signer-core

The signing pipeline every `@nostr-wot/*` host shares. A NIP-07 call in a browser extension,
a NIP-46 `sign_event` from a relay, an Android NIP-55 intent and a LAN frame all become one
`SignerRequest` and run through one `SignerCore.handle`. There is no path to a signature that
does not pass through it.

This is the component that decides whether a caller gets a signature. It is a security
control, not glue, and its order is fixed:

1. Resolve the active account.
2. Check permissions. A deny at any consulted level ends the request: it never reaches a
   prompt and is never routed anywhere, remote signer included.
3. An `ask` enqueues an approval and presents it through the `ApprovalPort`.
4. Unlock if required.
5. Execute through the signing backend, inside the vault's `withPrivkey`.
6. Zero key material.
7. Record an activity entry, respond.

Permissions are checked before lock state. A denied permission holds whether or not the key
is available. Reordering these steps is a regression, not a refactor.

## Install

```bash
npm i @nostr-wot/signer-core
```

## Use

```ts
import { SignerCore } from '@nostr-wot/signer-core';

const core = new SignerCore({
  vault,        // @nostr-wot/vault
  permissions,  // @nostr-wot/permissions
  identity,     // your source of truth for the active account, locked or not
  approval,     // your prompt: present(request, account) and cancel(requestId, reason)
  activity,     // your log: record(entry)
});

const signed = await core.handle({
  id: 'req_1',
  origin: { kind: 'web', identifier: 'example.com' },
  method: 'signEvent',
  params: { event: { kind: 1, content: 'hello', tags: [] } },
  receivedAt: Date.now(),
});
```

`handle` resolves with the method's result and rejects with a `SignerError` carrying a stable
`code` for every refusal. A refusal is never a `null` or an empty result, and its message is
always fixed text: whatever a port, a store, the vault or a cipher threw is given to the
`logger` and to the activity entry's `reason`, never to the caller. `SignerError` carries
`wireVisible: true`, which is what `@nostr-wot/bunker` checks before forwarding a message.

`identity` is required. The permission check needs the account and runs before lock state is
consulted, and a locked vault cannot name its account, so the host has to. Keep the active
account id outside the vault, as the extension does.

Whenever the active account changes, call `core.onActiveAccountChanged(previousId, nextId)`.
It rejects everything queued for the previous account and clears the `getPublicKey`
cooldown, so a caller cannot receive the new account's identity from a prompt shown for the
old one.

## Params per method

| Method | `params` |
| --- | --- |
| `getPublicKey`, `getRelays` | none |
| `signEvent` | `{ event: { kind, content, tags, created_at?, pubkey? } }` |
| `nip04Encrypt`, `nip44Encrypt` | `{ pubkey, plaintext }` |
| `nip04Decrypt`, `nip44Decrypt` | `{ pubkey, ciphertext }` |

Everything is validated by `validateRequest` at the boundary and nowhere else: an integer
`kind`, a string `content`, an array of string arrays as `tags`, pubkeys as 64 lowercase hex
characters, and the extension's size limits, applied before anything large is copied or
serialised. What comes out is a frozen deep copy: the prompt shows it and the signer signs it,
so the two cannot drift.

Origins are canonical. A `web` identifier is either an http(s) origin, which is what a
browser's `location.origin` is and what `@nostr-wot/permissions` keys on — canonicalised by
that package's own `canonicalHttpOrigin` (scheme and host lowercased, a default port dropped,
credentials or a path refused; never the host's `URL`, which on React Native folds nothing),
with `http://` and `https://` as different keys and the legacy bare-hostname rule read
underneath — or a bare hostname, lower-cased with trailing dots removed. Anything else with
a `:` is refused, so a web caller cannot spell another transport's namespace; that includes a
bare `localhost:3000` or `[::1]`, which arrive as `http://localhost:3000` and `http://[::1]:8080`
anyway. A `nip46` identifier is a lowercase hex pubkey.

## Optional ports

| Port | Without it |
| --- | --- |
| `unlock` | A request that needs the key while the vault is locked is refused after the permission gate. |
| `remote` | A NIP-46 account cannot sign or encrypt. |
| `relays` | `getRelays` answers `{}`. |
| `logger` | A failing activity log is silent. It never fails the request. |

## Queue

`MAX_PENDING_PER_ORIGIN` (5) caps the prompts one origin may have open; unlock markers and
in-flight remote work do not count toward it, and are bounded by the in-flight caps instead.
`REQUEST_TIMEOUT_MS` (120 s) rejects anything unanswered. `core.pending()` lists what is
waiting, for a badge or a list; `core.cancel(origin, id)` settles one from the host's side,
scoped to the origin because NIP-46 request ids are chosen by the client.

## Wiring to `@nostr-wot/bunker`

Pass `handlerTimeoutMs: 0` to the bunker. This pipeline owns the request timeout; two
120-second clocks on one request race each other and leave one side holding a live entry.

## Permission keys

A web identifier is stored as itself: the exact origin (`https://example.com`), or the bare
hostname older stores used. Every other origin kind is prefixed: `nip46:<pubkey>`,
`nip55:<package>`, `lan:<device>`, `local:<id>`. See `permissionOrigin`.
