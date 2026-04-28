import { hydrateMessages, _sessionState, _resetSession } from "./store";
import { evictIfNeeded } from "./eviction";
import type { DMMessage, DMSession, DMStorage } from "./types";

export type { DMMessage, DMConversation, DMSession, DMStorage, SendDMOptions } from "./types";
export { ingestMessage, getThread, getConversations, _sessionState, _resetSession } from "./store";
export {
  subscribeInbox,
  fetchInboxRelays,
  publishInboxRelays,
  relaysForPartner,
  KIND_NIP17_INBOX_RELAYS,
} from "./inbox";
export { sendDM } from "./send";
export { backfillInbox } from "./backfill";
export type { BackfillOptions, BackfillResult } from "./backfill";
export {
  setReadCursor,
  markRead,
  getReadCursor,
  getReadCursors,
  getUnreadCount,
  getUnreadCounts,
  subscribeReadCursors,
  detectScheme,
  _resetReadCursors,
} from "./read-cursors";
export {
  getOrCreateCacheKey,
  encryptToCache,
  decryptFromCache,
  wrapStorageWithEncryption,
  _resetCacheKeyState,
} from "./encrypted-storage";
export {
  setFollowSet,
  getFollowSet,
  subscribeFollowSet,
  evictIfNeeded,
  _resetFollowSets,
} from "./eviction";

/**
 * Bootstrap a DM session: hydrates persisted conversations (if storage
 * provided), wires auto-persist if requested, then returns a ready-to-use
 * session handle. The caller typically immediately calls
 * `subscribeInbox(session)` to start receiving inbound messages.
 *
 * Idempotent per `myPubkey` — calling twice returns the same session.
 *
 * `autoPersist` (default `true` when `storage` is set): debounced save on
 * every cache mutation. Set `false` and call `persistDMSession` manually
 * if you want explicit control.
 *
 * `evictionCap` (default `2000`): once at least this many evictable
 * messages exist after each ingest, oldest non-followed are dropped.
 * No-op until `setFollowSet` is called.
 */
export async function initDMSession(args: {
  myPubkey: string;
  signer: DMSession["signer"];
  relays: string[];
  storage?: DMSession["storage"];
  discoverInboxRelays?: boolean;
  autoPersist?: boolean;
  autoPersistDebounceMs?: number;
  evictionCap?: number;
}): Promise<DMSession> {
  const session: DMSession = {
    myPubkey: args.myPubkey,
    signer: args.signer,
    relays: args.relays,
    ...(args.storage !== undefined ? { storage: args.storage } : {}),
    ...(args.discoverInboxRelays !== undefined
      ? { discoverInboxRelays: args.discoverInboxRelays }
      : {}),
  };
  if (args.storage) {
    try {
      const persisted = await args.storage.load(args.myPubkey);
      hydrateMessages(args.myPubkey, persisted);
    } catch {
      /* storage unavailable; continue with empty cache */
    }
  }

  const cap = args.evictionCap ?? 2000;
  const debounceMs = args.autoPersistDebounceMs ?? 500;
  const autoPersist = args.autoPersist ?? Boolean(args.storage);

  const state = _sessionState(args.myPubkey);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = state.conversations.subscribe(args.myPubkey, () => {
    evictIfNeeded(args.myPubkey, cap);
    if (!autoPersist || !args.storage) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void persistDMSession(session).catch(() => {
        /* persistence failure is non-fatal; cache stays in memory */
      });
    }, debounceMs);
  });
  session._autoPersistOff = () => {
    if (timer) clearTimeout(timer);
    off();
  };

  return session;
}

/**
 * Tear down a session: stops auto-persist + eviction subscriptions. Does
 * NOT clear cached messages — call `clearDMSession` for that.
 */
export function closeDMSession(session: DMSession): void {
  session._autoPersistOff?.();
  session._autoPersistOff = undefined;
}

/**
 * Wipe all in-memory state for `myPubkey` (cache, follow set, read
 * cursors). Optionally clear persisted storage too. Use on logout /
 * account-switch.
 */
export async function clearDMSession(
  myPubkey: string,
  opts: { storage?: DMStorage; clearStorage?: boolean } = {},
): Promise<void> {
  _resetSession(myPubkey);
  if (opts.clearStorage && opts.storage) {
    try {
      await opts.storage.save(myPubkey, {});
    } catch {
      /* ignore */
    }
  }
}

/**
 * Persist the current cache snapshot to the session's storage backend.
 * Call manually on a debounce, or wire to `_sessionState().messages`
 * subscriber if you want auto-save.
 */
export async function persistDMSession(session: DMSession): Promise<void> {
  if (!session.storage) return;
  const state = _sessionState(session.myPubkey);
  const out: Record<string, ReturnType<typeof Array.from>> = {};
  for (const [partner, msgs] of state.messagesByPartner) {
    // Strip raw event before persisting to keep size + on-disk surface small
    out[partner] = msgs.map((m) => {
      const { raw: _raw, ...rest } = m;
      return rest;
    });
  }
  await session.storage.save(session.myPubkey, out as Parameters<typeof session.storage.save>[1]);
}

/**
 * Built-in localStorage storage backend. Plaintext at rest — for
 * sensitive use, wrap the JSON with NIP-44 KEK encryption (see
 * `@nostr-wot/dm/cache/encrypted-storage` in a future release).
 */
export function localStorageDMStorage(): DMStorage | undefined {
  if (typeof window === "undefined" || !window.localStorage) return undefined;
  return {
    async load(myPubkey: string): Promise<Record<string, DMMessage[]>> {
      try {
        const raw = window.localStorage.getItem(`@nostr-wot/dm:${myPubkey}`);
        return raw ? (JSON.parse(raw) as Record<string, DMMessage[]>) : {};
      } catch {
        return {};
      }
    },
    async save(myPubkey: string, conversations: Record<string, DMMessage[]>): Promise<void> {
      try {
        window.localStorage.setItem(`@nostr-wot/dm:${myPubkey}`, JSON.stringify(conversations));
      } catch {
        /* quota / private mode */
      }
    },
  };
}
