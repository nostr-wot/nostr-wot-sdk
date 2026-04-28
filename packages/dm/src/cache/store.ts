import { createKeyedObservable, type KeyedObservable } from "@nostr-wot/data/cache";
import type { DMConversation, DMMessage } from "./types";

/**
 * Per-session state. We keep two observables:
 *   - `messages` keyed by partner pubkey → DMMessage[] (newest last)
 *   - `conversations` keyed by `myPubkey` → DMConversation[] sorted by
 *     lastMessageAt desc (the inbox view)
 *
 * Both fan out to subscribers via React's useSyncExternalStore.
 */

type SessionState = {
  myPubkey: string;
  messagesByPartner: Map<string, DMMessage[]>;
  messages: KeyedObservable<string, DMMessage[]>;
  conversations: KeyedObservable<string, DMConversation[]>;
  /** Set of message ids we've already ingested (dedup across re-runs). */
  seenMessageIds: Set<string>;
};

const sessions = new Map<string, SessionState>();

function getOrCreate(myPubkey: string): SessionState {
  let s = sessions.get(myPubkey);
  if (!s) {
    s = {
      myPubkey,
      messagesByPartner: new Map(),
      messages: createKeyedObservable<string, DMMessage[]>(),
      conversations: createKeyedObservable<string, DMConversation[]>(),
      seenMessageIds: new Set(),
    };
    sessions.set(myPubkey, s);
  }
  return s;
}

export function _sessionState(myPubkey: string): SessionState {
  return getOrCreate(myPubkey);
}

/** Push a freshly decrypted message into the cache. Idempotent: returns
 *  false if the message id was already seen. */
export function ingestMessage(myPubkey: string, msg: DMMessage): boolean {
  const s = getOrCreate(myPubkey);
  if (s.seenMessageIds.has(msg.id)) return false;
  s.seenMessageIds.add(msg.id);

  const existing = s.messagesByPartner.get(msg.partnerPubkey) ?? [];
  // Insert in created_at order
  const inserted = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt);
  s.messagesByPartner.set(msg.partnerPubkey, inserted);
  s.messages.set(msg.partnerPubkey, inserted);

  // Recompute conversation list
  const convs: DMConversation[] = [];
  for (const [partner, msgs] of s.messagesByPartner) {
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
  s.conversations.set(myPubkey, convs);
  return true;
}

function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

export function getThread(myPubkey: string, partnerPubkey: string): DMMessage[] {
  return getOrCreate(myPubkey).messagesByPartner.get(partnerPubkey) ?? [];
}

export function getConversations(myPubkey: string): DMConversation[] {
  return getOrCreate(myPubkey).conversations.get(myPubkey).value ?? [];
}

/**
 * Hydrate from persistent storage (in-memory cache + observables get
 * populated). Called by `initDMSession` on startup.
 */
export function hydrateMessages(
  myPubkey: string,
  conversations: Record<string, DMMessage[]>,
): void {
  const s = getOrCreate(myPubkey);
  for (const [partner, msgs] of Object.entries(conversations)) {
    for (const m of msgs) s.seenMessageIds.add(m.id);
    const sorted = [...msgs].sort((a, b) => a.createdAt - b.createdAt);
    s.messagesByPartner.set(partner, sorted);
    s.messages.set(partner, sorted);
  }
  // Recompute conversations
  const convs: DMConversation[] = [];
  for (const [partner, msgs] of s.messagesByPartner) {
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
  s.conversations.set(myPubkey, convs);
}

/** Test helper. */
export function _resetSession(myPubkey: string): void {
  sessions.delete(myPubkey);
}
