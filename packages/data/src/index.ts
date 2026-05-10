// Pool + relay defaults
export {
  getPool, setPool, resetPool,
  getDefaultRelays, setDefaultRelays,
  getProfileAggregators, setProfileAggregators,
  DEFAULT_TIMEOUT_MS,
  // Deprecated direct constants kept for back-compat
  DEFAULT_RELAYS, PROFILE_AGGREGATORS,
} from "./pool";

// Cache configuration (re-exported so callers can configure persistence
// without importing the cache module directly).
export { configurePersistence } from "./cache/persistence";

// Subscription coalescer (debounces concurrent reads into one REQ per relay-set)
export {
  RequestCoalescer,
  sharedCoalescer,
  type CoalescerEnqueue,
  type CoalescerOptions,
  type QuerySyncOptions,
} from "./coalescer";

// Outbox (NIP-65)
export { relaysForAuthor, readRelaysForAuthor } from "./outbox";

// Parsers
export { parseKind0, type ProfileEntry } from "./parsers/kind0";
export {
  parseRelayList,
  isPublicWssUrl,
  type RelayListEntry,
  type RelayListFilter,
} from "./parsers/kind10002";
export { parseInboxRelayList } from "./parsers/kind10050";
export { parseZapMsats } from "./parsers/kind9735";
export { findReplyParentId, findRootEventId } from "./parsers/reply-detection";

// Address / mention utilities
export {
  npubToHex,
  hexToNpub,
  formatPubkey,
  nsecToBytes,
  nsecToHex,
  shortNpub,
  extractMentionPubkeys,
  findNpubMentions,
  type NpubMentionMatch,
} from "./addresses";

// Browser-side WebSocket subclass that coerces binary frames to UTF-8
// strings before nostr-tools' SimplePool sees them. Pass to
// `new SimplePool({ websocketImplementation: TextCoercingWebSocket })`.
export { TextCoercingWebSocket } from "./text-coercing-websocket";

// Keyed observable primitive — backs every per-kind cache. Apps that
// build their own caches (e.g. DM-relay-routed profile cache) reuse it
// rather than reimplementing the Map + subscriber + dedup pattern.
export {
  createKeyedObservable,
  type Slot,
  type SlotStatus,
  type KeyedObservable,
  type KeyedObservableOptions,
} from "./cache/keyed-observable";

// Fetchers
export { fetchProfile, streamProfile } from "./fetchers/profile";
export { fetchNote, type NoteEntry } from "./fetchers/note";
export { fetchNotesByAuthor } from "./fetchers/notes-by-author";
export { fetchFollows, type FollowsEntry } from "./fetchers/follows";
export { fetchEngagement, type Engagement } from "./fetchers/engagement";
export { fetchThread } from "./fetchers/thread";
export { fetchRelayList } from "./fetchers/relay-list";
