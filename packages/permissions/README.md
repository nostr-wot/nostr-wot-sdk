# @nostr-wot/permissions

The authorization layer every `@nostr-wot/*` signer funnels through: given a caller, a method and
an event kind, may this happen.

NIP-07 in a browser extension, NIP-55 from an Android app and NIP-46 from a remote signer differ
in how a request arrives, not in who is allowed to make it. So the decision lives here once, over
an injected [`KeyValueStore`](../storage), and touches no platform global.

## Install

```bash
npm i @nostr-wot/permissions
```

## The cascade

Three levels are consulted, most specific first: the kind-specific key (`signEvent:1`), the
method-level key (`signEvent`), then the wildcard (`*`).

**Deny wins.** An explicit `deny` at any consulted level ends the matter. A kind-specific `allow`
cannot override a method-level or wildcard `deny`, and a broad `*` allow cannot bypass a narrower
deny. Only when nothing denies does specificity decide, in the order kind > method > wildcard. A
bucket that says nothing about a request returns `ask`.

```ts
import { resolve } from '@nostr-wot/permissions';

resolve({ '*': 'allow' }, 'signEvent', 1); // 'allow'
resolve({ 'signEvent:1': 'allow', '*': 'deny' }, 'signEvent', 1); // 'deny'
resolve({}, 'signEvent', 1); // 'ask'
```

`resolve` is pure, so the security critical part of this package is testable without storage.

## Permission keys

| Method | Key |
| --- | --- |
| `signEvent`, kind 1 | `signEvent:1` |
| `signEvent`, kinds 4 / 13 / 14 / 1059 | `sendMessages` |
| `nip04Encrypt`, `nip44Encrypt` | `sendMessages` |
| `nip04Decrypt`, `nip44Decrypt` | `readMessages` |
| `webln_*` | unchanged |
| anything else | its own name |

The DM kinds collapse so one approval covers the whole send-a-DM flow, encrypt and the matching
signature, instead of prompting twice. The consequence is deliberate: denying sign-of-DM-kind
without also denying encrypt is not expressible, because it is one decision.

Because of that collapse, nothing ever consults a raw `signEvent:4`, `:13`, `:14` or `:1059` key,
so `saveDirect` **throws** on one rather than storing a rule that can never fire. Write
`sendMessages`, or go through `save`, which maps the kind for you.

## Usage

```ts
import { MemoryStore } from '@nostr-wot/storage';
import { Permissions } from '@nostr-wot/permissions';

const permissions = new Permissions(new MemoryStore(), { logger: console });

await permissions.migrate(); // once per store, safe to call on every start

if ((await permissions.check('example.com', 'signEvent', 1, accountId)) === 'ask') {
  const decision = await promptTheUser();
  await permissions.save('example.com', 'signEvent', 1, decision, accountId);
}
```

An `origin` is whatever identifies the caller: a web origin, an Android package name, a remote
signer's public key. Only `http(s)` origins additionally answer to their bare hostname, which is
how rules stored by older versions are still read.

An `http(s)` origin is stored and read under one canonical spelling, computed by
`canonicalHttpOrigin` in this package rather than by the host's `URL`: scheme and host
lowercased, a default port dropped, IPv4 and IPv6 addresses written one way, and anything with
credentials or a path refused. React Native's `URL` folds neither case nor ports, so a check
built on `new URL(x).origin === x` would let `https://EXAMPLE.COM` and `https://example.com:443`
each hold their own rules on a phone; `test/origin.test.ts` runs the same table under a `URL`
shaped like React Native's and checks the parser is never consulted.

**Every mutating method throws on an empty origin, key or account id.** `''` type-checks wherever
a label is expected and means nothing, so it is treated as a caller bug rather than as a wildcard
or a no-op — notably `clear('')`, which does *not* mean "wipe everything" (omit the argument for
that). Reads stay tolerant: an unknown origin resolves to `ask`, and a check that throws into a
signing path would be worse than one that prompts. `undefined` and `null` keep their documented
meanings.

## Modes

The two modes are mutually exclusive, and `getUseGlobalDefaults()` is `true` when nothing is
stored.

- **Global** — every account shares the `_default` bucket, and `accountId` is ignored.
- **Per-account** — each account has its own bucket, and an account with no bucket asks.

**In per-account mode a missing or empty `accountId` fails closed.** It resolves to no bucket at
all: `check` answers `ask`, `getAll` and `getForOrigin` come back empty, and a write throws rather
than landing in the shared `_default` bucket. This is a deliberate divergence from the browser
extension, which resolves `accountId || '_default'` in both modes. The extension gets away with it
because it has one call site; with four transports feeding this package, an optional parameter one
call site forgets is exactly how a cross-account leak ships. One extra approval prompt on a path
that should not occur is cheaper than an unauthorized signature.

Dormant data survives a switch: only the active mode's bucket is read or written.
`setupNewAccountPermissions` uses that carefully — in global mode it copies each existing
account's shared rules into its own bucket **before** switching to per-account mode, so the
existing accounts keep what they had and only the new account starts fresh.

## Storage compatibility

Keys and shape are the browser extension's, unchanged, so a migrated extension reads its own data:

```json
{
  "signerPermissions": {
    "example.com": { "_default": { "signEvent:1": "allow" }, "acct_abc": { "*": "deny" } }
  },
  "signerUseGlobalDefaults": true
}
```

`migrate()` runs the four migrations in order — blanket keys dropped, flat rules bucketed under
`_default`, the retired `forward` value rewritten to `ask`, and DM kinds folded into
`sendMessages` most-restrictive-wins — then records `_permMigrationVersion`.

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

This package itself uses neither `TextEncoder` nor `TextDecoder`, and clones the permission
tree with a JSON round trip. Its origin parsing is its own and never consults the host's `URL`.

## License

MIT
