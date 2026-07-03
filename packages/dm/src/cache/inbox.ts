import type { Event as NostrEvent, EventTemplate } from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";
import { fetchRelayList, getPool, sharedCoalescer } from "@nostr-wot/data";
import {
  KIND_GIFT_WRAP,
  KIND_NIP04_DM,
  decryptNip04,
  unwrapGiftWrap,
} from "../index";
import { ingestMessage } from "./store";
import type { DMMessage, DMSession } from "./types";

const KIND_NIP17_INBOX_RELAYS = 10050;
export { KIND_NIP17_INBOX_RELAYS };

/**
 * Publish a kind-10050 event listing the relays the user wants to
 * receive NIP-17 DMs on. Other clients sending us gift-wrapped DMs look
 * up this event to know where to publish; without it, our DMs only
 * arrive from senders who happen to share a relay with us.
 *
 * Single-shot: typically called once on DM-session bootstrap, or on
 * signer attach.
 */
export async function publishInboxRelays(
  signer: NostrSigner,
  publishRelays: string[],
  inboxRelays: string[],
): Promise<NostrEvent> {
  const template: EventTemplate = {
    kind: KIND_NIP17_INBOX_RELAYS,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: inboxRelays.map((url) => ["relay", url]),
  };
  const event = await signer.signEvent(template);
  const pool = getPool();
  await Promise.allSettled(pool.publish(publishRelays, event));
  return event;
}

/**
 * Look up the user's NIP-17 inbox relays (kind 10050). Other clients
 * publishing wraps to us inspect this list — we MUST subscribe on these
 * relays or we'll miss inbound DMs.
 *
 * Falls back to the session's configured relay set if no kind 10050 is
 * published.
 */
export async function fetchInboxRelays(
  pubkey: string,
  fallbackRelays: string[],
): Promise<string[]> {
  const events = await sharedCoalescer.querySync(
    [{ kinds: [KIND_NIP17_INBOX_RELAYS], authors: [pubkey], limit: 1 }],
    { relays: fallbackRelays, timeoutMs: 5000 },
  );
  const newest = events.reduce<NostrEvent | null>(
    (acc: NostrEvent | null, e: NostrEvent) =>
      !acc || e.created_at > acc.created_at ? e : acc,
    null,
  );
  if (!newest) return fallbackRelays;
  const relays = newest.tags
    .filter((t: string[]) => t[0] === "relay" && typeof t[1] === "string")
    .map((t: string[]) => t[1]!)
    .filter((r: string) => r.startsWith("ws"));
  return relays.length > 0 ? [...new Set([...relays, ...fallbackRelays])] : fallbackRelays;
}

/**
 * Subscribe to inbound DMs (both NIP-04 kind-4 and NIP-17 kind-1059
 * gift wraps). Each event is decrypted with the session's signer and
 * pushed into the cache. Returns a teardown function.
 *
 * Two parallel subscriptions, one per kind. The coalescer dedupes
 * concurrent reads from other consumers (profile cache, follows, etc).
 */
export function subscribeInbox(session: DMSession): () => void {
  const myPk = session.myPubkey;
  let inboxRelays: string[] = session.relays;
  let unsubA: (() => void) | null = null;
  let unsubB: (() => void) | null = null;
  let unsubC: (() => void) | null = null;
  let cancelled = false;

  void (async () => {
    if (session.discoverInboxRelays !== false) {
      inboxRelays = await fetchInboxRelays(myPk, session.relays);
    }
    if (cancelled) return;

    // NIP-04 inbound: kind 4 with #p == me
    unsubA = sharedCoalescer.enqueue({
      filters: [{ kinds: [KIND_NIP04_DM], "#p": [myPk] }],
      relays: inboxRelays,
      onEvent: (e) => void handleNip04(session, e),
    });

    // NIP-04 outbound (so we see our own messages echoed by relays): authored by me
    unsubB = sharedCoalescer.enqueue({
      filters: [{ kinds: [KIND_NIP04_DM], authors: [myPk] }],
      relays: inboxRelays,
      onEvent: (e) => void handleNip04(session, e),
    });

    // NIP-17 inbound: kind 1059 with #p == me
    unsubC = sharedCoalescer.enqueue({
      filters: [{ kinds: [KIND_GIFT_WRAP], "#p": [myPk] }],
      relays: inboxRelays,
      onEvent: (e) => void handleGiftWrap(session, e),
    });
  })();

  return () => {
    cancelled = true;
    unsubA?.();
    unsubB?.();
    unsubC?.();
  };
}

async function handleNip04(session: DMSession, event: NostrEvent): Promise<void> {
  try {
    const plaintext = await decryptNip04(session.signer, event);
    const partnerPk =
      event.pubkey === session.myPubkey
        ? event.tags.find((t) => t[0] === "p")?.[1]
        : event.pubkey;
    if (!partnerPk) return;
    const msg: DMMessage = {
      id: event.id,
      fromPubkey: event.pubkey,
      partnerPubkey: partnerPk,
      content: plaintext,
      createdAt: event.created_at,
      scheme: "nip04",
      raw: event,
    };
    ingestMessage(session.myPubkey, msg);
  } catch {
    /* decryption failure (likely a different recipient); skip */
  }
}

async function handleGiftWrap(session: DMSession, event: NostrEvent): Promise<void> {
  try {
    const { message, senderPubkey } = await unwrapGiftWrap(session.signer, event);
    const partnerPk =
      senderPubkey === session.myPubkey
        ? message.tags.find((t) => t[0] === "p")?.[1]
        : senderPubkey;
    if (!partnerPk) return;
    const msg: DMMessage = {
      id: message.id,
      fromPubkey: senderPubkey,
      partnerPubkey: partnerPk,
      content: message.content,
      createdAt: message.created_at,
      scheme: "nip17",
      raw: event,
    };
    ingestMessage(session.myPubkey, msg);
  } catch {
    /* not addressed to us, or decrypt failed; skip */
  }
}

/**
 * Re-fetch a partner's NIP-65 write relays (outbox model) and merge
 * with the session's defaults. Use when querying or sending to a
 * specific partner.
 */
export async function relaysForPartner(
  partnerPubkey: string,
  defaults: string[],
): Promise<string[]> {
  const list = await fetchRelayList(partnerPubkey, defaults).catch(() => null);
  if (!list || list.write.length === 0) return defaults;
  return [...new Set([...list.write, ...defaults])];
}
