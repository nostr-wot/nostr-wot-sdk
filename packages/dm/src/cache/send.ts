import type { Event as NostrEvent } from "nostr-tools";
import { getPool } from "@nostr-wot/data";
import {
  buildChatMessage,
  encryptNip04,
  sealAndGiftWrap,
} from "../index";
import { _publishPool, relaysForPartner } from "./inbox";
import { ingestMessage } from "./store";
import type { DMMessage, DMSession, SendDMOptions } from "./types";

void _publishPool; // silence unused-export warning

/**
 * Send a DM to `partnerPubkey`. Returns the on-the-wire event after
 * publishing to (your relays ∪ partner's NIP-65 write relays).
 *
 * The decrypted message is ALSO ingested into the local cache
 * immediately so the sender's UI sees the message without waiting for
 * the relay echo.
 */
export async function sendDM(
  session: DMSession,
  partnerPubkey: string,
  content: string,
  options: SendDMOptions = {},
): Promise<NostrEvent> {
  const scheme = options.scheme ?? "nip17";
  const targetRelays = await relaysForPartner(partnerPubkey, session.relays);
  const pool = getPool();

  let event: NostrEvent;
  if (scheme === "nip04") {
    event = await encryptNip04(session.signer, partnerPubkey, content);
  } else {
    const inner = buildChatMessage(session.myPubkey, partnerPubkey, content);
    event = await sealAndGiftWrap(session.signer, partnerPubkey, inner);
  }

  // Local-echo: drop the plaintext into our own cache so the UI updates
  // instantly. Use the inner event's id when sealed, the outer event's
  // id otherwise — needs to match what the inbox subscription would see.
  const localMsg: DMMessage = {
    // For NIP-17 the inner event's id isn't computed here (we don't
    // expose it from sealAndGiftWrap), so we use the gift-wrap id as a
    // surrogate. The inbox dedupes by this id; when our own subscription
    // surfaces the event later, it'll be seen-already and skipped.
    id: scheme === "nip04" ? event.id : `local:${event.id}`,
    fromPubkey: session.myPubkey,
    partnerPubkey,
    content,
    createdAt: Math.floor(Date.now() / 1000),
    scheme,
    raw: event,
  };
  ingestMessage(session.myPubkey, localMsg);

  // Publish (fire-and-forget; we don't block the UI on relay acks)
  await Promise.allSettled(pool.publish(targetRelays, event));
  return event;
}
