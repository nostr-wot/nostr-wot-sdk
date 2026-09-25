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
| `nip04Encrypt` | `{ pubkey, plaintext }` |
| `nip44Encrypt` | `{ pubkey, plaintext, opts?: { scheme: 'pq', recipientKemKey } }` |
| `nip04Decrypt`, `nip44Decrypt` | `{ pubkey, ciphertext }` |
| `signPqAttestation` | none |

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

## Post-quantum

The extension already handles post-quantum payloads; a signer that shares its vault and
does not is a bridge that drops messages, which is worse than one that refuses them. So
the pipeline does what the extension does, spelled the same, and the cryptography is
`@nostr-wot/pq`'s: ML-KEM-1024 and ML-DSA-87 keys, the `kind:10203` attestation, the hybrid
ML-KEM + NIP-44 envelope.

**Keys.** An account's post-quantum keys are resolved by `withPqKeys(vault, account, fn)`,
in the extension's order: imported keys first (an account only holds them when it could
not derive, and they are what its published attestation advertises), otherwise derived
from the seed phrase at the account's own derivation path (`derivationPath`, else
`derivationIndex`, else 0), so two sub-accounts on one seed do not share keys and an
account restored at a custom path derives under that path. Nothing is stored: derived keys
are recomputed per request from the mnemonic already in the vault. Only a 24-word phrase
may derive; a 12-word phrase is refused (`unsupported`, "Post-quantum keys require a 24-word
seed phrase") rather than handed a 128-bit key that looks strong, and an account with no
phrase and no import is refused with "This account has no seed phrase, so it cannot use
post-quantum keys". Those refusals reach the caller on purpose, after the permission gate
and any prompt: `schemes` advertises what the signer accepts, not what the selected account
can do, and the caller has to be able to tell the user which of the reasons it hit.

`withPqKeys` is the only path to the secrets. It hands its callback live key material and
registers every secret with the vault through `withDerivedSecrets`, so one `lock()` zeroes
the derived ML-KEM and ML-DSA keys where they are rather than whenever the callback happens
to finish — exactly as `withPrivkey`'s copy is zeroed, and held to it by a test that locks
mid-callback and reads all three. A result computed under a session that moved is voided,
and no secret bytes are returned: a callback that hands the buffer back gets zeros. It is
opened only for a request that needs it; a classic request never reads the seed phrase or
the imported keys.

**Decrypt routes on the payload.** `nip44Decrypt` takes no flag. The envelope is
self-describing (a version byte and an algorithm byte), so the boundary decides the route
once (`scheme: 'pq' | 'classic'` on the validated params, required, never defaulted): a
hybrid payload decrypts through the post-quantum path, a classic one through the path
everyone uses today, byte for byte, and anything else fails as `operation_failed`. Never
silently, never partially.

**And a broken hybrid payload is reported as hybrid.** `pq`'s `classifyEnvelope` answers three
things where a boolean answered two: a whole envelope, one whose header names our version and
which we cannot open (truncated, an algorithm byte we do not implement, base64 this host cannot
decode), and somebody else's payload. The middle case used to come back false and be routed
classic, so it failed as `operation_failed` with `scheme: 'classic'` in the activity log, which
sends whoever is debugging it to NIP-44 code that never saw a payload like it. It now carries
`scheme: 'pq'`, `envelope: 'unreadable'` on the validated params, and is refused with "This
post-quantum payload is not a readable hybrid envelope" — in the caller's error and in the
entry's `reason`. The header is read without a host base64 decoder for exactly this reason: a
host missing `atob` would otherwise route every valid hybrid payload classic. A payload claiming
a version we have never heard of is indistinguishable from a classic ciphertext of that version
and stays classic; that is the limit of what the wire format allows, and it is not papered over.

**Encrypt is opt-in, exactly as the extension.** `nip44Encrypt` seals hybrid only when the
caller passes `opts: { scheme: 'pq', recipientKemKey }`, the recipient's ML-KEM-1024 key as
2092 base64 characters from their `kind:10203`. It is never inferred from a relay lookup:
that would put network I/O inside a signing operation and leave only two answers when the
lookup fails, break every caller or fall back to classic silently, and a silent downgrade
is the failure the whole scheme exists to prevent. The application that fetched the
attestation passes the key it has. The options are validated at the boundary as the
extension validates them, and any other spelling is `invalid_request` rather than classic.
The sending account needs its own post-quantum keys too, as in the extension.

**A remote account cannot do post-quantum, and is told so.** A bunker knows nothing about
the envelope; it would answer a hybrid encrypt with classic ciphertext the caller cannot
tell apart. A post-quantum request on a NIP-46 account is refused at the routing step,
after the permission gate, before the remote port sees it: "Remote signers do not support
post-quantum encryption", "Remote signers cannot read post-quantum messages". Classic
requests still go to the bunker.

**The attestation is a signing request like any other.** `signPqAttestation` builds and
signs the account's own `kind:10203`: the ML-KEM and ML-DSA public keys, `origin: derived`
with `seed_strength: 256` for keys from the seed or `origin: independent` with no seed
strength for imported ones, the ML-DSA proof of possession, then the secp256k1 signature,
in the extension's tag order. It runs the whole pipeline under the `signEvent` rule for kind
10203: a stored deny on that kind, or on signing at all, refuses it without a prompt; a
remembered approval is stored as `signEvent:10203`. The result is the signed event; the
host publishes it. `verifyPqAttestation(event)` is the check for someone else's: kind,
secp256k1 signature, then the tags, with `usable: false` and typed problems otherwise.

**And the prompt shows that event, not the method name.** The attestation is the one method
whose event this pipeline computes rather than receives, so it computes it *before* asking and
hands the approval port a `signEvent` request carrying the full `kind:10203` — every tag, the
proof of possession, the `created_at` — which is what a host's existing event preview renders,
with no case for a method name it has never heard of. The template the prompt shows is the
template that gets signed: the proof of possession is randomised, so rebuilding it after
approval would put a different event on the wire than the one the user saw.

That has one visible consequence. Building the event needs the account's post-quantum keys, so
for `signPqAttestation` the unlock runs **before** the prompt rather than after it, and an
account whose keys cannot be resolved is refused instead of being asked. The alternative —
prompt first, showing a preview — could only show the event with the proof of possession
missing, because computing that is what needs the key; that is showing the user something other
than what gets signed, on the one screen where the difference is the point. Opening the vault is
not consent to sign: the permission cascade short-circuits a deny before any unlock, the prompt
still follows, and a refusal still refuses. The cost is a biometric before the approval screen
instead of after it, which is a user-experience cost and not a security one. The activity entry
keeps `method: 'signPqAttestation'` and now carries the event it signed, as a `signEvent` entry
does.

**What it costs.** ML-KEM and ML-DSA are not free, and everything below runs synchronously
on the JavaScript thread. Measured on Node 24, Apple silicon, mean of 100:

| Operation | Time |
| --- | --- |
| `nip44Decrypt`, classic, through the pipeline | 3.7 ms |
| `nip44Decrypt`, post-quantum, through the pipeline | 21.7 ms |
| `nip44Encrypt`, post-quantum, through the pipeline | 21.9 ms |
| `signPqAttestation`, through the pipeline | 44.5 ms (max 92 ms) |
| of which: seed phrase to keys, per request (PBKDF2-SHA512 then two keygens) | 15.5 ms |
| of which: ML-DSA-87 sign (proof of possession; rejection sampling, so it varies) | 25.7 ms (max 121 ms) |

Fifteen of every post-quantum request's milliseconds are the per-request derivation the
extension also pays. Hermes without a JIT is commonly 10 to 30 times slower than V8 on
this kind of arithmetic, so a host on a phone should expect a few hundred milliseconds per
post-quantum message and a second or more for the attestation. Measure on the device before
deciding whether to move the work off the UI thread.

A batch of N post-quantum items is N of those in a row, and it **yields between every one**,
which is the only reason it is usable on a phone. Same harness, Node 24 on Apple silicon, one
64-item batch per row, with a 1 ms timer running alongside it:

| 64-item batch | Total | Longest unbroken block | Timer ticks during the batch |
| --- | --- | --- | --- |
| classic `nip44Decrypt` | 305 ms (was 233) | 6.5 ms (was 233) | 63 (was 0) |
| post-quantum `nip44Decrypt` | 1426 ms (was 1361) | 25.8 ms (was 1361) | 63 (was 0) |
| post-quantum `nip44Encrypt` | 1430 ms (was 1354) | 23.9 ms (was 1354) | 63 (was 0) |
| `signPqAttestation` | 2847 ms (was 2778) | 70.5 ms (was 2778) | 63 + 63 (was 0) |

The totals are ~1 ms per item worse, which is the clamped timer, and the longest stretch the
thread is busy falls from the whole batch to one operation. Before this, a 1 ms timer running
next to a 64-item batch did not fire at all until the batch was over: everything the pipeline
awaits between items is a microtask, and a microtask runs before the next timer, before layout
and before a touch handler. So the batch was one contiguous block — 1.4 s of it on Node, tens
of seconds under Hermes, on a device the user could not interact with. Batching exists because
iOS charges a gesture per signature, so a batch that freezes the phone defeats its own purpose.

The work itself is unchanged: 64 post-quantum items still cost what 64 post-quantum items cost,
and a host that wants a smaller unit sends a smaller batch. What changed is that the device
stays alive through it, a host can show progress, and `revokeOrigin` is honoured in the same
gap. Nothing is cancelled by the yield, and `handle` for a single request is untouched.

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
  A `signPqAttestation` item is built before the prompt and shown as the `signEvent` it is, for
  the reason above, which is also why a batch carrying one unlocks first and refuses outright
  when the account cannot produce it.
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
- **The host gets a turn between items.** Each gap between two items is a real macrotask, not
  an `await Promise.resolve()`, so a pending timer, a frame and a gesture can run in it. Without
  it a 64-item post-quantum batch was 1.4 seconds of unbroken CPU during which a 1 ms timer did
  not fire once; see the table under [Post-quantum](#post-quantum) for what it costs and buys.
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
signer port so a timeout, a switch or a disposal can abort the call in flight. Two more come in
with the post-quantum path: **`atob`** and **`btoa`**, which `@nostr-wot/pq`'s base64 helpers
reach for (with a `Buffer` fallback Hermes does not have either) to decode a stored ML-KEM key
and to read a payload's envelope header. Missing them throws nothing; it silently makes every
hybrid payload unrecognisable, which is why they are declared here rather than left to be
discovered. Node, browsers and React Native 0.74 or newer have all seven except that React
Native has to polyfill the random source. Storage, the clock and password stretching are injected as
ports. `structuredClone`, `URL`, WebCrypto's `subtle`, the DOM and the WebExtension namespaces
are never used, and `packages/vault/test/boundaries.test.ts` plus the ESLint config enforce
that.

This package needs them through `@nostr-wot/vault` and `@nostr-wot/accounts`. Its own
`utf8ByteLength` counts UTF-8 bytes without encoding, not to avoid `TextEncoder` but so the
boundary never allocates an encoded copy of untrusted input before the size limit has bitten.

The post-quantum path's cryptography adds no requirement of its own: `@noble/post-quantum`
reaches for `crypto.getRandomValues` (ML-KEM encapsulation, ML-DSA's hedged signing) and
nothing else, and that is already on the list. Its base64 is what adds `atob` and `btoa`
above, and an older React Native host needs a polyfill for them as it does for the random
source. Without one the failure is loud rather than silent: a payload that names the hybrid
envelope but cannot be decoded is refused as a post-quantum payload, with that in the error
and in the activity entry, instead of being routed classic and failing there.
