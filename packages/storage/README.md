# @nostr-wot/storage

The storage port every other `@nostr-wot/*` package writes against — one key/value interface,
supplied by whatever host the code is running on.

This package depends on nothing. It touches no platform global and no UI framework, so the same
compiled module loads in an extension, in a mobile app, in a Node process and in a test run. The
host decides where bytes actually live; nothing above this line has to know.

## Install

```bash
npm i @nostr-wot/storage
```

## The interface

```ts
interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  subscribe?(listener: (key: string) => void): () => void;
}
```

`subscribe` is optional — not every backend can report changes. Check for it before calling.

Implementations behave as a *value* store, not a reference store: what comes back out of `get`
is unaffected by later mutation of what went into `set`, and vice versa. A backend that
serializes gets that for free; `MemoryStore` deep clones to match it, so a test that passes
against `MemoryStore` passes against the real thing.

## `MemoryStore`

In-memory, for tests and for state that should not outlive the process.

```ts
import { MemoryStore } from '@nostr-wot/storage';

const store = new MemoryStore({ seeded: 'value' });
await store.set('profile', { name: 'leon' });
await store.get('profile'); // { name: 'leon' } — a fresh copy each time
```

## `namespaced`

Views one store as a private sub-store, prefixing every key with `${prefix}:`. Two subsystems
sharing one physical store cannot read or clobber each other by picking the same key name.

```ts
import { namespaced } from '@nostr-wot/storage';

const signer = namespaced(store, 'signer');
const cache = namespaced(store, 'cache');

await signer.set('key', 'a'); // lands at `signer:key`
await cache.set('key', 'b');  // lands at `cache:key`
await signer.keys();          // ['key'] — unprefixed, and only its own
```

`keys()` reports unprefixed keys and filters out every other namespace. `subscribe`, when the
underlying store has one, does the same. Nesting composes: `namespaced(namespaced(s, 'a'), 'b')`
writes `a:b:key`.

Keys are free-form and may contain the `:` separator. The *prefix* is percent-escaped so that
they can, which keeps the mapping from `(prefix, key)` to storage key injective — without it,
`namespaced(s, 'a').set('b:c', …)` and `namespaced(s, 'a:b').set('c', …)` would both write
`a:b:c` and silently clobber each other.

## Host requirements

The `@nostr-wot` shared packages (`storage`, `accounts`, `vault`, `permissions`, `signer-core`)
run on one rule: nothing platform-specific is reached for, and what a host must supply is
injected or declared. Two globals are declared requirements of the family rather than
avoided, because `@noble/hashes` and `@noble/ciphers` use them internally and the vault and
accounts packages use them for the same UTF-8 conversions: **`TextEncoder`** and
**`TextDecoder`**. Node, browsers and Hermes all have them; a host that somehow lacks one
polyfills it before importing. Everything else these packages need beyond ES2022 is injected
as a port. `structuredClone`, WebCrypto, the DOM and the WebExtension namespaces are never
used, and `packages/vault/test/boundaries.test.ts` plus the ESLint config enforce that.

This package itself uses neither `TextEncoder` nor `TextDecoder`; `MemoryStore` clones with a JSON
round trip, which is also what every real backend does on the way to disk.

## License

MIT
