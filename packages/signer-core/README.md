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
  approval,     // your prompt: present(request, account) and cancel(origin, requestId, reason)
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

When the host stops trusting a caller (a remote client revoked, a paired device removed, a
site forgotten), call `core.revokeOrigin(originKey, reason?)`. It clears that origin's
`getPublicKey` cooldown, which would otherwise admit a revoked client's next `connect`
without a prompt for up to a minute, and rejects everything the origin has queued, prompts
on screen included, and stops a batch already executing between items. The key is
canonicalised as the boundary canonicalises it, and every spelling of a site is covered:
`example.com` revokes `https://example.com` and `http://example.com:8080`, and the other way
round. It is `onActiveAccountChanged` scoped to an origin. It is not a deny: store a
permission for that. `core.clearCooldown(originKey)` is the narrow form, for re-asking
without cutting the caller off.

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

The envelope is bounded too, before anything is copied: `id` at 256 characters,
`origin.identifier` at 512, `origin.displayName` at 128 and `origin.icon` at 2048. All four are
written verbatim into every activity entry, denied requests included, so an unbounded one would
let any connected page fill the user's storage. An opaque origin (`location.origin === 'null'`:
a sandboxed iframe, a `data:` page, Chrome's `file://`) is refused as a web identifier, because
every such page reports the same string and one remembered allow would cover all of them.

## Batches

One request carrying many items, one approval, many signatures. On iOS every signature costs
a user gesture that nothing can suppress, so ten reactions and two zaps are twelve prompts,
roughly a minute of the user's attention; one batch is one prompt.

```ts
const result = await core.handleBatch({
  id: 'batch_1',
  origin: { kind: 'web', identifier: 'example.com' },
  items: [
    { id: 'a', method: 'signEvent', params: { event: { kind: 7, content: '+', tags: [['e', id]] } } },
    { id: 'b', method: 'signEvent', params: { event: { kind: 9734, content: '', tags } } },
    { id: 'c', method: 'nip44Encrypt', params: { pubkey, plaintext } },
  ],
  receivedAt: Date.now(),
});
for (const item of result.items) {
  if (item.ok) publish(item.result);
  else console.log(item.id, item.code, item.message);
}
```

A batch is a first-class request, not a loop over single ones, and it runs the same pipeline
in the same order. What differs is deliberate, and each rule is written on `#runBatch`:

- **Every item is shown.** The `ApprovalPort` gets `presentBatch(batch, account)` with the
  whole frozen batch: every item, full content, every tag. A host that does not implement it
  cannot show a batch, so a batch that needs a prompt is refused as `unsupported`; a batch
  every item of which is already allowed still signs. Same for `UnlockPort.requestUnlockBatch`.
- **Permissions are per item.** A batch of kinds 1, 7 and 1059 reads the rule for each, before
  lock state. A `deny` on any item refuses the whole batch as `permission_denied` before any
  prompt: a stored deny is the user's standing answer, and neither re-asking it nor hiding it
  from the prompt is acceptable. Allowed items are still shown; `remember` persists only the
  rules that were unset.
- **Partial failure is per item, and the result says which.** `handleBatch` resolves with a
  `BatchResult` whose `items` carry `{ id, ok: true, result }` or `{ id, ok: false, code,
  message }`, in order. Each item is signed in its own `withPrivkey` scope, so eight of ten
  sign and the vault locks gives eight signatures and two `vault_locked` outcomes; one
  undecryptable message is one `operation_failed`, not a failed batch. A refusal of the batch
  as a whole (malformed, denied, rejected by the user, timed out, the account switched, the
  vault locked with no way to open it) rejects with a `SignerError` like `handle` does, and a
  switch anywhere between the prompt and the last item refuses every item, signed or not.
- **A batch is one queued request.** It counts once toward `MAX_PENDING_PER_ORIGIN`, because
  that cap bounds prompts and a batch is one prompt. Its size is bounded at the boundary
  instead: `MAX_BATCH_ITEMS` (64) and `MAX_BATCH_BYTES`, which equals `MAX_EVENT_BYTES` on
  purpose so a batch can hold no more than one request can. Both bite before any item is
  walked or copied.
- **Only key methods batch.** `getPublicKey` and `getRelays` have their own consent model and
  are refused as items; a transport answers them through `handle`. A remote (NIP-46) account
  cannot batch: the bunker runs its own approval per request.

Every item lands in the activity log under its own id with `batchId` set, whatever happened.
`onActiveAccountChanged` rejects a queued batch as it rejects a single request, and the
port's `cancel` names the batch id.

## Optional ports

| Port | Without it |
| --- | --- |
| `unlock` | A request that needs the key while the vault is locked is refused after the permission gate. Its `requestUnlockBatch` is optional; without it a batch that finds the vault locked is refused. |
| `remote` | A NIP-46 account cannot sign or encrypt. |
| `relays` | `getRelays` answers `{}`. |
| `logger` | A failing activity log is silent. It never fails the request. |

## Queue

`MAX_PENDING_PER_ORIGIN` (5) caps the prompts one origin may have open; unlock markers and
in-flight remote work do not count toward it, and are bounded by the in-flight caps instead.
`REQUEST_TIMEOUT_MS` (120 s) rejects anything unanswered. `core.pending()` lists what is
waiting, for a badge or a list; `core.cancel(origin, id)` settles one from the host's side, and
the port's `cancel(origin, id, reason)` is told the origin for the same reason,
scoped to the origin because NIP-46 request ids are chosen by the client.

## Wiring to `@nostr-wot/bunker`

Pass `handlerTimeoutMs: 0` to the bunker. This pipeline owns the request timeout; two
120-second clocks on one request race each other and leave one side holding a live entry.

## Permission keys

A web identifier is stored as itself: the exact origin (`https://example.com`), or the bare
hostname older stores used. Every other origin kind is prefixed: `nip46:<pubkey>`,
`nip55:<package>`, `lan:<device>`, `local:<id>`. See `permissionOrigin`.

## Host requirements

The `@nostr-wot` shared packages (`storage`, `accounts`, `vault`, `permissions`, `signer-core`)
run on one rule: nothing platform-specific is reached for, and what a host must supply is
injected or declared. Two globals are declared requirements of the family rather than
avoided, because `@noble/hashes` and `@noble/ciphers` use them internally and the vault and
accounts packages use them for the same UTF-8 conversions: **`TextEncoder`** and
**`TextDecoder`**. Two more are required and easy to miss because nothing in these packages'
own source names them: **`crypto.getRandomValues`** on `globalThis`, which `@noble`'s
`randomBytes` reaches for (the vault's salt, IV and cache key; the ncryptsec salt and nonce)
and THROWS without — on Hermes that means importing `react-native-get-random-values` before
anything else — and timers, **`setTimeout`** / `clearTimeout`, which run the vault's auto-lock
and the queue's request timeout, and **`AbortController`**, which the queue hands a remote
signer port so a timeout, a switch or a disposal can abort the call in flight. Node, browsers
and React Native have all five except that React Native has to polyfill the random source. Storage, the clock and password stretching are injected as
ports. `structuredClone`, `URL`, WebCrypto's `subtle`, the DOM and the WebExtension namespaces
are never used, and `packages/vault/test/boundaries.test.ts` plus the ESLint config enforce
that.

This package needs them through `@nostr-wot/vault` and `@nostr-wot/accounts`. Its own
`utf8ByteLength` counts UTF-8 bytes without encoding, not to avoid `TextEncoder` but so the
boundary never allocates an encoded copy of untrusted input before the size limit has bitten.
