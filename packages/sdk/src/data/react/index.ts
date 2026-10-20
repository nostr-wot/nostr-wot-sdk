import { useEffect, useSyncExternalStore } from "react";
import { useSigner, usePubkey } from "./session-context";
import { getPool, getDefaultRelays } from "../pool";
import { fastNewest } from "../internal/sub";
import type { EventTemplate } from "nostr-tools";
import {
  _profileStore,
  getProfile,
  _noteStore,
  getNote,
  _authorNotesStore,
  getAuthorNotes,
  loadMoreAuthorNotes,
  _followsStore,
  getFollows,
  _engagementStore,
  fetchEngagementBatch,
  getEngagement,
  _threadStore,
  getThread,
  _relayListStore,
  getRelayList,
  type AuthorNotesEntry,
  type ThreadEntry,
} from "../cache";
import type { ProfileEntry } from "../parsers/kind0";
import type { NoteEntry } from "../fetchers/note";
import type { FollowsEntry } from "../fetchers/follows";
import type { Engagement } from "../fetchers/engagement";
import type { RelayListEntry } from "../parsers/kind10002";

export function useProfile(pubkey: string | null): ProfileEntry | null {
  const store = _profileStore();
  useEffect(() => {
    if (pubkey) void getProfile(pubkey).catch(() => null);
  }, [pubkey]);
  return useSyncExternalStore(
    (cb) => (pubkey ? store.subscribe(pubkey, () => cb()) : () => {}),
    () => (pubkey ? store.get(pubkey).value ?? null : null),
    () => null,
  );
}

export function useNote(id: string | null, hintRelays: string[] = []): NoteEntry | null {
  const store = _noteStore();
  useEffect(() => {
    if (id) void getNote(id, hintRelays).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return useSyncExternalStore(
    (cb) => (id ? store.subscribe(id, () => cb()) : () => {}),
    () => (id ? store.get(id).value ?? null : null),
    () => null,
  );
}

export function useAuthorNotes(pubkey: string | null): {
  entry: AuthorNotesEntry | null;
  loadMore: () => Promise<void>;
  isLoading: boolean;
} {
  const store = _authorNotesStore();
  useEffect(() => {
    if (pubkey) void getAuthorNotes(pubkey).catch(() => null);
  }, [pubkey]);
  const entry = useSyncExternalStore(
    (cb) => (pubkey ? store.subscribe(pubkey, () => cb()) : () => {}),
    () => (pubkey ? store.get(pubkey).value ?? null : null),
    () => null,
  );
  const isLoading = useSyncExternalStore(
    (cb) => (pubkey ? store.subscribe(pubkey, () => cb()) : () => {}),
    () => (pubkey ? store.get(pubkey).status === "loading" : false),
    () => false,
  );
  return {
    entry,
    isLoading,
    loadMore: async () => {
      if (!pubkey) return;
      await loadMoreAuthorNotes(pubkey).catch(() => null);
    },
  };
}

export function useFollows(pubkey: string | null): FollowsEntry | null {
  const store = _followsStore();
  useEffect(() => {
    if (pubkey) void getFollows(pubkey).catch(() => null);
  }, [pubkey]);
  return useSyncExternalStore(
    (cb) => (pubkey ? store.subscribe(pubkey, () => cb()) : () => {}),
    () => (pubkey ? store.get(pubkey).value ?? null : null),
    () => null,
  );
}

// Stable singleton — see engagement-cache.ts for why this matters
// (useSyncExternalStore tearing check triggers React #185 if getSnapshot
// returns a fresh object on each render).
const EMPTY_ENGAGEMENT: Engagement = Object.freeze({
  reactionCount: 0,
  repostCount: 0,
  zapTotalSats: 0,
}) as Engagement;

export function useEngagement(noteId: string | null): Engagement {
  const store = _engagementStore();
  return useSyncExternalStore(
    (cb) => (noteId ? store.subscribe(noteId, () => cb()) : () => {}),
    () => (noteId ? getEngagement(noteId) : EMPTY_ENGAGEMENT),
    () => EMPTY_ENGAGEMENT,
  );
}

export function useEngagementBatch(noteIds: string[]): void {
  // Stable identity from joined string so the effect re-runs only when
  // the set actually changes.
  const k = noteIds.join(",");
  useEffect(() => {
    if (noteIds.length === 0) return;
    void fetchEngagementBatch(noteIds).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
}

export function useThread(rootId: string | null): ThreadEntry | null {
  const store = _threadStore();
  return useSyncExternalStore(
    (cb) => (rootId ? store.subscribe(rootId, () => cb()) : () => {}),
    () => (rootId ? store.get(rootId).value ?? null : null),
    () => null,
  );
}

export async function loadThread(rootId: string): Promise<void> {
  await getThread(rootId).catch(() => null);
}

export function useRelayList(pubkey: string | null): RelayListEntry | null {
  const store = _relayListStore();
  useEffect(() => {
    if (pubkey) void getRelayList(pubkey).catch(() => null);
  }, [pubkey]);
  return useSyncExternalStore(
    (cb) => (pubkey ? store.subscribe(pubkey, () => cb()) : () => {}),
    () => (pubkey ? store.get(pubkey).value ?? null : null),
    () => null,
  );
}

export type PublishProfileFields = {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  banner?: string;
  website?: string;
  lud16?: string;
  nip05?: string;
};

/**
 * Returns a `publishProfile` callback that merges the provided fields into
 * the caller's existing kind-0 event, then signs and publishes the result.
 * Returns null when no signer is attached to the session.
 */
export function usePublishProfile(): ((fields: PublishProfileFields) => Promise<void>) | null {
  const session = useSigner();
  const pubkey = usePubkey();

  if (!session || !pubkey) return null;

  return async (fields: PublishProfileFields) => {
    const relays = getDefaultRelays();
    const existing = await fastNewest(relays, { kinds: [0], authors: [pubkey] });
    let base: Record<string, unknown> = {};
    if (existing) {
      try { base = JSON.parse(existing.content) as Record<string, unknown>; } catch { /* ignore */ }
    }
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== "") merged[k] = v;
    }
    const template: EventTemplate = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(merged),
    };
    const signed = await session.signEvent(template);
    const pool = getPool();
    await Promise.allSettled(pool.publish(relays, signed as never));
  };
}

// One-shot ad-hoc filter query (NIP-50 search, custom kinds, …) routed
// through the shared coalescer.
export {
  useNostrQuery,
  type UseNostrQueryOptions,
  type UseNostrQueryResult,
} from './use-nostr-query';

// Provider for configuring relays / aggregators / cache from React
export { NostrDataProvider, type NostrDataProviderProps } from './nostr-data-provider';

// Session context — shared mount point for the active signer + pubkey.
// Other @nostr-wot/* packages and apps read auth state from here.
export {
  NostrSessionProvider,
  useSession,
  useSigner,
  usePubkey,
  useLogin,
  useLogout,
  useKEKSigner,
  type SessionSigner,
  type SessionState,
  type KEKSigner,
  type NostrSessionProviderProps,
} from './session-context';
