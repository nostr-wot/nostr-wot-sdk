/**
 * Follow-aware LRU eviction for the in-memory DM cache.
 *
 * Storage is finite. Without a cap, a long-running session accumulates
 * unbounded messages. The naive fix is "drop oldest"; the smart fix is
 * "drop oldest UNLESS the partner is in the user's follow set". Active
 * relationships stay protected; cold spam from random pubkeys gets
 * evicted first.
 *
 * Cold-start contract:
 *   - Never calling `setFollowSet` (or calling with `null`) → eviction is
 *     a no-op (all partners protected). Use this state until the kind-3
 *     follow list has been hydrated.
 *   - `new Set()` → empty follow list known; full LRU.
 *   - `new Set([...])` → only listed partners protected.
 *
 * The same contract obelisk uses, lifted so other clients don't reinvent it.
 */

import { _sessionState } from "./store";

type FollowSetState = Set<string> | null;

const followSets = new Map<string, FollowSetState>();
const subscribers = new Map<string, Set<() => void>>();

/** Register the follow set for `myPubkey`. See module docstring for semantics. */
export function setFollowSet(
  myPubkey: string,
  set: Set<string> | null,
): void {
  followSets.set(myPubkey, set);
  const subs = subscribers.get(myPubkey);
  if (subs) for (const cb of subs) cb();
}

/** Read the current follow set. `null` means cold-start (un-hydrated). */
export function getFollowSet(myPubkey: string): Set<string> | null {
  return followSets.get(myPubkey) ?? null;
}

/** Subscribe to follow-set updates for `myPubkey`. */
export function subscribeFollowSet(
  myPubkey: string,
  cb: () => void,
): () => void {
  let s = subscribers.get(myPubkey);
  if (!s) {
    s = new Set();
    subscribers.set(myPubkey, s);
  }
  s.add(cb);
  return () => {
    s!.delete(cb);
    if (s!.size === 0) subscribers.delete(myPubkey);
  };
}

/**
 * Drop oldest non-followed messages until the count of evictable
 * messages fits under `cap`. Followed partners are always preserved.
 *
 * Returns the number of messages dropped.
 *
 * Cold-start safety: if no follow set has been registered for
 * `myPubkey`, this is a no-op (all messages protected).
 */
export function evictIfNeeded(myPubkey: string, cap = 2000): number {
  const followsEntry = followSets.has(myPubkey)
    ? followSets.get(myPubkey)
    : undefined;
  if (followsEntry === undefined || followsEntry === null) return 0;
  const follows = followsEntry;

  const state = _sessionState(myPubkey);
  // Flatten + tag each message with its partner so we can sort globally.
  type Item = { partner: string; idx: number; ts: number };
  const evictable: Item[] = [];
  let totalEvictable = 0;

  for (const [partner, msgs] of state.messagesByPartner) {
    if (follows.has(partner)) continue;
    for (let i = 0; i < msgs.length; i++) {
      evictable.push({ partner, idx: i, ts: msgs[i]!.createdAt });
      totalEvictable++;
    }
  }

  if (totalEvictable <= cap) return 0;

  evictable.sort((a, b) => a.ts - b.ts);
  const drop = evictable.slice(0, totalEvictable - cap);

  // Group by partner so we splice once per partner.
  const dropIdx = new Map<string, Set<number>>();
  for (const it of drop) {
    let s = dropIdx.get(it.partner);
    if (!s) {
      s = new Set();
      dropIdx.set(it.partner, s);
    }
    s.add(it.idx);
  }

  let dropped = 0;
  for (const [partner, idxSet] of dropIdx) {
    const old = state.messagesByPartner.get(partner) ?? [];
    const next: typeof old = [];
    for (let i = 0; i < old.length; i++) {
      if (idxSet.has(i)) {
        state.seenMessageIds.delete(old[i]!.id);
        dropped++;
        continue;
      }
      next.push(old[i]!);
    }
    if (next.length === 0) {
      state.messagesByPartner.delete(partner);
    } else {
      state.messagesByPartner.set(partner, next);
    }
    state.messages.set(partner, next);
  }

  // Recompute conversation list
  const convs = [];
  for (const [partner, msgs] of state.messagesByPartner) {
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    convs.push({
      partnerPubkey: partner,
      lastMessageAt: last.createdAt,
      preview: previewOf(last.content),
      messageCount: msgs.length,
    });
  }
  convs.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  state.conversations.set(myPubkey, convs);

  return dropped;
}

function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

/** Test/lifecycle reset. */
export function _resetFollowSets(): void {
  followSets.clear();
  subscribers.clear();
}
