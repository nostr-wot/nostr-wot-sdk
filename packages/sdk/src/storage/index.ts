/**
 * `@nostr-wot/storage` — the storage port shared by every `@nostr-wot` package.
 *
 * One interface, {@link KeyValueStore}, that each host satisfies in its own way, so the
 * code above it is written once. This package deliberately touches no platform global and
 * no UI framework: it depends on nothing outside the language itself. It ships the
 * interface, an in-memory implementation for tests and ephemeral state, and a namespacing
 * wrapper that lets several subsystems share one physical store without colliding.
 */
export type { KeyValueStore } from './types.js';
export { MemoryStore } from './memory.js';
export { namespaced } from './namespaced.js';
