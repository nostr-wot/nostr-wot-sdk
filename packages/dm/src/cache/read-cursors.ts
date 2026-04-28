/**
 * Per-thread read-cursor tracking. Device-local: read state is *never*
 * synced to relays — no server should know who you're DMing or when you
 * last read them.
 *
 * Storage: localStorage by default. Pure functions so any state-management
 * layer (Zustand, Jotai, plain hooks) can wrap them.
 */

import type { DMMessage } from "./types";
import { _sessionState } from "./store";

const KEY = "@nostr-wot/dm:read-cursors";
const ramCursors = new Map<string, Record<string, number>>();
const subscribers = new Map<string, Set<() => void>>();

/** Test/lifecycle reset. */
export function _resetReadCursors(): void {
  ramCursors.clear();
  subscribers.clear();
}

function load(myPubkey: string): Record<string, number> {
  const cached = ramCursors.get(myPubkey);
  if (cached) return cached;
  if (typeof localStorage === "undefined") {
    const empty: Record<string, number> = {};
    ramCursors.set(myPubkey, empty);
    return empty;
  }
  try {
    const raw = localStorage.getItem(`${KEY}:${myPubkey}`);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    ramCursors.set(myPubkey, parsed);
    return parsed;
  } catch {
    const empty: Record<string, number> = {};
    ramCursors.set(myPubkey, empty);
    return empty;
  }
}

function persist(myPubkey: string, cursors: Record<string, number>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${KEY}:${myPubkey}`, JSON.stringify(cursors));
  } catch {
    /* quota / private mode */
  }
}

function notify(myPubkey: string): void {
  const set = subscribers.get(myPubkey);
  if (!set) return;
  for (const cb of set) cb();
}

/**
 * Mark `partnerPubkey` as read up to `tsMs` (Unix ms). Monotonic: cursors
 * never go backwards.
 */
export function setReadCursor(
  myPubkey: string,
  partnerPubkey: string,
  tsMs: number,
): void {
  const cursors = load(myPubkey);
  if ((cursors[partnerPubkey] ?? 0) >= tsMs) return;
  cursors[partnerPubkey] = tsMs;
  persist(myPubkey, cursors);
  notify(myPubkey);
}

/** Mark `partnerPubkey` as read up to *now*. */
export function markRead(myPubkey: string, partnerPubkey: string): void {
  setReadCursor(myPubkey, partnerPubkey, Date.now());
}

/** Returns the last-read timestamp (Unix ms) for `partnerPubkey`, or 0. */
export function getReadCursor(
  myPubkey: string,
  partnerPubkey: string,
): number {
  return load(myPubkey)[partnerPubkey] ?? 0;
}

/** All cursors for `myPubkey`. */
export function getReadCursors(myPubkey: string): Record<string, number> {
  return { ...load(myPubkey) };
}

/**
 * Count messages from `partnerPubkey` whose `createdAt` (seconds → ms) is
 * newer than the read cursor and which were NOT sent by `myPubkey`.
 * Outbound messages are always considered read.
 */
export function getUnreadCount(
  myPubkey: string,
  partnerPubkey: string,
): number {
  const cursorMs = getReadCursor(myPubkey, partnerPubkey);
  const state = _sessionState(myPubkey);
  const msgs = state.messagesByPartner.get(partnerPubkey) ?? [];
  let count = 0;
  for (const m of msgs) {
    if (m.fromPubkey === myPubkey) continue;
    if (m.createdAt * 1000 > cursorMs) count++;
  }
  return count;
}

/**
 * Compute unread counts for every partner that has cached messages.
 * Useful for sidebar badges.
 */
export function getUnreadCounts(myPubkey: string): Record<string, number> {
  const out: Record<string, number> = {};
  const state = _sessionState(myPubkey);
  for (const partner of state.messagesByPartner.keys()) {
    const c = getUnreadCount(myPubkey, partner);
    if (c > 0) out[partner] = c;
  }
  return out;
}

/**
 * Subscribe to cursor mutations. Callback fires on any `setReadCursor`
 * for `myPubkey`. Returns an unsubscribe function.
 */
export function subscribeReadCursors(
  myPubkey: string,
  cb: () => void,
): () => void {
  let set = subscribers.get(myPubkey);
  if (!set) {
    set = new Set();
    subscribers.set(myPubkey, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(myPubkey);
  };
}

/**
 * Predict whether `partner` is currently using NIP-04 or NIP-17 based on
 * the most recent `lookback` cached messages. Returns `null` if there's
 * no signal (no messages, or perfectly mixed). Useful for showing a
 * "this contact uses legacy DMs" banner.
 */
export function detectScheme(
  messages: DMMessage[],
  lookback = 20,
): "nip04" | "nip17" | null {
  if (messages.length === 0) return null;
  const slice = messages.slice(-lookback);
  let four = 0;
  let seventeen = 0;
  for (const m of slice) {
    if (m.scheme === "nip04") four++;
    else if (m.scheme === "nip17") seventeen++;
  }
  if (four === seventeen) return null;
  return four > seventeen ? "nip04" : "nip17";
}
