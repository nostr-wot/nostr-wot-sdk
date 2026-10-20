# nostr-wot-sdk/storage

> Unreleased consolidation: this is the API guide for `nostr-wot-sdk/storage`. The former `@nostr-wot/storage` package becomes a deprecated compatibility re-export after the replacement is published. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

The storage port every other `@nostr-wot/*` package writes against — one key/value interface, supplied by whatever host the code is running on.

This storage module has no runtime dependencies of its own. It touches no platform global and no UI framework, so the same compiled module loads in an extension, in a mobile app, in a Node process and in a test run. The host decides where bytes actually live; nothing above this line has to know.

## Install

```bash
npm i nostr-wot-sdk
```

### Module format

Use ESM `import` as shown here. Module-format support is specific to the owning package and entry point; do not infer it from another package in the family. The storage entry point is ESM-only.

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

Implementations behave as a *value* store, not a reference store: what comes back out of `get` is unaffected by later mutation of what went into `set`, and vice versa. A backend that serializes gets that for free; `MemoryStore` deep clones to match it, so a test that passes against `MemoryStore` passes against the real thing.

## `MemoryStore`

In-memory, for tests and for state that should not outlive the process.

```ts
import { MemoryStore } from 'nostr-wot-sdk/storage';

const store = new MemoryStore({ seeded: 'value' });
await store.set('profile', { name: 'leon' });
await store.get('profile'); // { name: 'leon' } — a fresh copy each time
```

## `namespaced`

Views one store as a private sub-store, prefixing every key with `${prefix}:`. Two subsystems sharing one physical store cannot read or clobber each other by picking the same key name.

```ts
import { namespaced } from 'nostr-wot-sdk/storage';

const signer = namespaced(store, 'signer');
const cache = namespaced(store, 'cache');

await signer.set('key', 'a'); // lands at `signer:key`
await cache.set('key', 'b');  // lands at `cache:key`
await signer.keys();          // ['key'] — unprefixed, and only its own
```

`keys()` reports unprefixed keys and filters out every other namespace. `subscribe`, when the underlying store has one, does the same. Nesting composes: `namespaced(namespaced(s, 'a'), 'b')` writes `a:b:key`.

Keys are free-form and may contain the `:` separator. The *prefix* is percent-escaped so that they can, which keeps the mapping from `(prefix, key)` to storage key injective — without it, `namespaced(s, 'a').set('b:c', …)` and `namespaced(s, 'a:b').set('c', …)` would both write `a:b:c` and silently clobber each other.

## Host requirements

The portable account, vault, permission and signing modules use injected storage and host ports. They require `TextEncoder`, `TextDecoder`, secure `crypto.getRandomValues`, timers and `AbortController`; post-quantum paths additionally require `atob`/`btoa` or the supported Buffer fallback. Initialize the necessary React Native/Hermes polyfills before importing these modules, including `react-native-get-random-values` for secure randomness. Do not substitute a non-cryptographic random source.

The portable cryptographic core does not require the DOM, WebExtension APIs or WebCrypto `subtle`. Platform adapters such as WebAuthn ceremonies and relay transports have their own requirements. See the [identity runtime guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/identity/README.md#runtime-requirements).

This package itself uses neither `TextEncoder` nor `TextDecoder`; `MemoryStore` clones with a JSON round trip, which is also what every real backend does on the way to disk.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
