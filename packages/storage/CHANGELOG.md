# @nostr-wot/storage

## 0.2.0

### Minor Changes

- [`302f897`](https://github.com/nostr-wot/nostr-wot-sdk/commit/302f897e5e1bc854ef5ad8a07433b15c513ea996) Thanks [@leonacostaok](https://github.com/leonacostaok)! - First release of `@nostr-wot/storage`, the key/value port every other `@nostr-wot` package writes against.

  One interface, `KeyValueStore`: `get`, `set`, `remove`, `keys`, and an optional `subscribe` a store omits when its backing cannot report changes, so callers check for it rather than being handed a listener that never fires. The host satisfies it however it stores bytes (extension storage, a keychain, SQLite, a file, a map) and nothing above this line has to know which, which is what lets the signer stack be written once and run in an extension, in a React Native app, in a Node process and in a test. Implementations are held to value semantics, not reference semantics: what `get` returns must be unaffected by later mutation of what went into `set`. `MemoryStore`, included for tests and ephemeral state, deep clones to achieve that.

  `namespaced(store, prefix)` views one physical store as a private sub-store, and the prefixing is collision-proof rather than string concatenation. Keys are free-form and may contain the separator, so the prefix is percent-escaped first: without that, `namespaced(store, 'a').set('b:c')` and `namespaced(store, 'a:b').set('c')` both write `a:b:c` and each view silently reads and clobbers the other, which is the one guarantee the module exists to provide. `keys()` and `subscribe` report a namespace's own keys unprefixed and never a neighbour's, and nesting composes.

  The package depends on nothing, imports no framework and touches no platform global, which the repository's ESLint boundary and `packages/vault/test/boundaries.test.ts` both enforce. ESM only; the README says what that means for a CommonJS caller.
