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
`code` for every refusal. A refusal is never a `null` or an empty result.

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
characters, and the extension's size limits. What comes out is a frozen deep copy: the prompt
shows it and the signer signs it, so the two cannot drift.

## Optional ports

| Port | Without it |
| --- | --- |
| `identity` | A locked vault cannot name its active account, and the permission check needs one, so a locked vault refuses every request rather than prompting. |
| `unlock` | A request that needs the key while the vault is locked is refused after the permission gate. |
| `remote` | A NIP-46 account cannot sign or encrypt. |
| `relays` | `getRelays` answers `{}`. |
| `logger` | A failing activity log is silent. It never fails the request. |

## Queue

`MAX_PENDING_PER_ORIGIN` (5) caps the prompts one origin may have open; unlock markers and
in-flight remote work do not count toward it, and are bounded by the in-flight caps instead.
`REQUEST_TIMEOUT_MS` (120 s) rejects anything unanswered. `core.pending()` lists what is
waiting, for a badge or a list; `core.cancel(id)` settles one from the host's side.

## Permission keys

A web origin is stored bare, as the browser extension already stores it. Every other origin
kind is prefixed: `nip46:<pubkey>`, `nip55:<package>`, `lan:<device>`, `local:<id>`. See
`permissionOrigin`.
