import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent,
  type Event,
  type EventTemplate,
  type UnsignedEvent,
} from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";
import { decryptPq, encryptPq, isPqEnvelope } from "@nostr-wot/pq";

/**
 * Direct Messages — three kinds, in increasing order of privacy:
 *
 *   - **NIP-04** (legacy): kind 4, AES-CBC, leaks metadata (sender +
 *     recipient). Still widely deployed; use as fallback.
 *   - **NIP-44** v2: kind 14 wrapped in kind 1059 (gift wrap) per NIP-17,
 *     OR raw kind 14 if the participants agreed out-of-band. Hides
 *     content + sender, but recipient is still visible on-the-wire.
 *   - **NIP-17 sealed messages**: NIP-44 ciphertext sealed inside a
 *     gift-wrapped kind-1059 event. Hides BOTH sender and recipient
 *     from observers — the recipient is found via "to" tags on the
 *     gift wrap, but the inner sealed event has no metadata visible.
 *
 * This package provides:
 *   - `encryptDirectMessage` / `decryptDirectMessage` for kind-4 (legacy)
 *   - `sealAndGiftWrap` / `unwrapGiftWrap` for NIP-17 sealed messages
 *
 * `sealAndGiftWrap` also has an optional post-quantum mode (see `PqSealOptions`):
 * when supplied, the seal's `content` is `@nostr-wot/pq`'s hybrid ML-KEM-1024 +
 * NIP-44 envelope instead of plain NIP-44 ciphertext. Nothing outside the seal
 * changes, so relays and non-supporting clients still see an ordinary kind-1059.
 * `unwrapGiftWrap` auto-detects which kind of seal it received — the caller never
 * passes a flag — so a single conversation can freely mix classic and post-quantum
 * messages. This package depends on `@nostr-wot/pq` for the envelope only; it does
 * not reimplement it.
 */

export const KIND_NIP04_DM = 4;
export const KIND_NIP44_DM = 14;
export const KIND_SEALED = 13;
export const KIND_GIFT_WRAP = 1059;

// ─── NIP-04 (legacy) ────────────────────────────────────────────────

export async function encryptNip04(
  signer: NostrSigner,
  recipientPubkey: string,
  plaintext: string,
): Promise<Event> {
  if (!signer.nip04Encrypt) {
    throw new Error("Signer does not support NIP-04 encryption");
  }
  const ciphertext = await signer.nip04Encrypt(recipientPubkey, plaintext);
  const template: EventTemplate = {
    kind: KIND_NIP04_DM,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
    content: ciphertext,
  };
  return signer.signEvent(template);
}

export async function decryptNip04(
  signer: NostrSigner,
  event: Event,
): Promise<string> {
  if (!signer.nip04Decrypt) {
    throw new Error("Signer does not support NIP-04 decryption");
  }
  const myPk = await signer.getPublicKey();
  // If we sent it, the counterparty is the `p` tag. If we received it,
  // the counterparty is the event author.
  const counterparty =
    event.pubkey === myPk
      ? event.tags.find((t) => t[0] === "p")?.[1]
      : event.pubkey;
  if (!counterparty) throw new Error("Cannot determine NIP-04 counterparty");
  return signer.nip04Decrypt(counterparty, event.content);
}

// ─── NIP-17 sealed messages ─────────────────────────────────────────

/**
 * Build a kind-14 chat message template (NIP-17 inner event). Not
 * signed — pass to `sealAndGiftWrap` to produce the on-the-wire event.
 */
export function buildChatMessage(
  fromPubkey: string,
  toPubkey: string,
  content: string,
  options: { subject?: string; replyTo?: string } = {},
): UnsignedEvent {
  const tags: string[][] = [["p", toPubkey]];
  if (options.subject) tags.push(["subject", options.subject]);
  if (options.replyTo) tags.push(["e", options.replyTo, "", "reply"]);
  return {
    pubkey: fromPubkey,
    kind: KIND_NIP44_DM,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
}

/**
 * Post-quantum sealing input for `sealAndGiftWrap`. Carries exactly what
 * `@nostr-wot/pq`'s `encryptPq` needs beyond the plaintext itself — the sender and
 * recipient pubkeys it also needs are already in scope inside `sealAndGiftWrap`
 * (the inner message's `pubkey`, and the `recipientPubkey` argument).
 */
export interface PqSealOptions {
  /** Recipient's ML-KEM-1024 encapsulation key, from their kind:10203 attestation. */
  kemPublicKey: Uint8Array;
  /**
   * The classic NIP-44 v2 conversation key for this pair, e.g.
   * `nip44.v2.utils.getConversationKey(senderSecretKey, recipientPubkey)`.
   * `encryptPq`'s hybrid KDF needs the raw 32-byte key, not an encrypt/decrypt
   * operation, so a signer that only exposes `nip44Encrypt`/`nip44Decrypt` (NIP-07,
   * NIP-46) cannot supply this on its own — the caller derives it out of band. A
   * `PrivateKeySigner`-backed session can compute it directly from the held key.
   */
  conversationKey: Uint8Array;
}

export interface SealAndGiftWrapOptions {
  /**
   * Seal with a post-quantum envelope (`@nostr-wot/pq`) instead of plain NIP-44.
   * The seal's `content` becomes the envelope; everything outside the seal — kind,
   * tags, timestamps, the gift wrap itself — is unchanged, so a relay or a client
   * that hasn't implemented this still sees an ordinary kind-1059.
   */
  pq?: PqSealOptions;
}

/**
 * Wrap a chat message per NIP-17:
 *   1. Hash the inner unsigned event id (NIP-01 standard hash).
 *   2. Encrypt the inner event JSON — with NIP-44 between sender and recipient,
 *      or, in post-quantum mode, with `@nostr-wot/pq`'s hybrid envelope — into
 *      the "seal" (kind 13, signed by sender).
 *   3. Encrypt the seal with NIP-44 between an EPHEMERAL key and
 *      recipient → "gift wrap" (kind 1059, signed by ephemeral key).
 *
 * Returns the kind-1059 gift wrap, ready to publish to relays.
 */
export async function sealAndGiftWrap(
  signer: NostrSigner,
  recipientPubkey: string,
  message: UnsignedEvent,
  options: SealAndGiftWrapOptions = {},
): Promise<Event> {
  // Inner event id (no signature; per NIP-17 the inner event is unsigned)
  const innerWithId = { ...message, id: getEventHash(message as UnsignedEvent) };
  const innerJson = JSON.stringify(innerWithId);

  // Seal: kind 13, sender signs. Content is either the post-quantum envelope or
  // plain NIP-44 ciphertext, depending on `options.pq` — everything else about
  // the seal and the gift wrap around it is identical either way.
  let sealedContent: string;
  if (options.pq) {
    sealedContent = encryptPq(innerJson, options.pq.kemPublicKey, options.pq.conversationKey, {
      sender: message.pubkey,
      recipient: recipientPubkey,
    });
  } else {
    if (!signer.nip44Encrypt) {
      throw new Error("Signer does not support NIP-44 encryption (needed for NIP-17)");
    }
    sealedContent = await signer.nip44Encrypt(recipientPubkey, innerJson);
  }
  const sealTemplate: EventTemplate = {
    kind: KIND_SEALED,
    created_at: randomTimestampInPast(),
    tags: [],
    content: sealedContent,
  };
  const seal = await signer.signEvent(sealTemplate);

  // Gift wrap: kind 1059, ephemeral key signs, NIP-44 to recipient
  const ephSk = generateSecretKey();
  const ephPk = getPublicKey(ephSk);
  const conv = nip44.v2.utils.getConversationKey(ephSk, recipientPubkey);
  const wrapContent = nip44.v2.encrypt(JSON.stringify(seal), conv);
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomTimestampInPast(),
      tags: [["p", recipientPubkey]],
      content: wrapContent,
    },
    ephSk,
  );
}

/**
 * Post-quantum opening input for `unwrapGiftWrap`. Unlike `PqSealOptions`,
 * `conversationKey` can't be a single precomputed key: `unwrapGiftWrap` doesn't
 * know who sent a wrap until the seal is decrypted, so the counterparty pubkey
 * isn't known until mid-call. It's invoked once that's known.
 */
export interface PqUnwrapOptions {
  /** Recipient's ML-KEM-1024 secret key. */
  kemSecretKey: Uint8Array;
  /** Resolves the raw NIP-44 v2 conversation key for a counterparty pubkey. */
  conversationKey: (counterpartyPubkey: string) => Uint8Array | Promise<Uint8Array>;
}

export interface UnwrapGiftWrapOptions {
  /**
   * Enables opening post-quantum seals. Without this, a post-quantum seal in the
   * wrap fails the same generic way any other undecryptable seal does — there is
   * no separate "unsupported" error, for the same reason the signature and
   * authorship checks below don't get one either.
   */
  pq?: PqUnwrapOptions;
}

/**
 * Reverse of `sealAndGiftWrap`. Given a kind-1059 gift wrap addressed to
 * us, returns the inner unsigned chat message + the sender pubkey
 * (recovered from the seal's signature).
 *
 * The seal's content is self-describing — a post-quantum envelope carries its own
 * version/algorithm header (`isPqEnvelope`) — so the caller never states which kind
 * of message this is; a single conversation can freely mix both. Opening a
 * post-quantum seal requires `options.pq`.
 *
 * Throws if the gift wrap can't be decrypted or the seal kind/sig is
 * invalid.
 */
export async function unwrapGiftWrap(
  signer: NostrSigner,
  giftWrap: Event,
  options: UnwrapGiftWrapOptions = {},
): Promise<{ message: UnsignedEvent & { id: string }; senderPubkey: string }> {
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption (needed for NIP-17)");
  }
  if (giftWrap.kind !== KIND_GIFT_WRAP) {
    throw new Error(`Expected kind ${KIND_GIFT_WRAP}, got ${giftWrap.kind}`);
  }
  // Decrypt the wrap (ephemeral pubkey is giftWrap.pubkey). The wrap layer is
  // always classic secp256k1 + NIP-44, even for a post-quantum message — only the
  // seal's content ever carries the post-quantum envelope.
  const wrapPlaintext = await signer.nip44Decrypt(giftWrap.pubkey, giftWrap.content);
  const seal = JSON.parse(wrapPlaintext) as Event;
  if (seal.kind !== KIND_SEALED) {
    throw new Error(`Expected sealed kind ${KIND_SEALED}, got ${seal.kind}`);
  }
  // The seal's signature is checked alongside its decryption below, both folded into
  // the same generic failure: a caller must not be able to tell, from the error alone,
  // whether the seal failed to decrypt or merely failed to verify. Applies to both
  // the classic and the post-quantum path below.
  if (!verifyEvent(seal)) {
    throw new Error("Failed to decrypt seal");
  }

  let sealPlaintext: string;
  if (isPqEnvelope(seal.content)) {
    if (!options.pq) {
      throw new Error("Failed to decrypt seal");
    }
    try {
      const recipientPubkey = await signer.getPublicKey();
      const conversationKey = await options.pq.conversationKey(seal.pubkey);
      sealPlaintext = decryptPq(seal.content, options.pq.kemSecretKey, conversationKey, {
        sender: seal.pubkey,
        recipient: recipientPubkey,
      });
    } catch {
      throw new Error("Failed to decrypt seal");
    }
  } else {
    // Decrypt the seal (sender is seal.pubkey)
    sealPlaintext = await signer.nip44Decrypt(seal.pubkey, seal.content);
  }
  const message = JSON.parse(sealPlaintext) as UnsignedEvent & { id: string };
  // The rumor is unsigned, so its `pubkey` is only a claim — the seal's signature is
  // the only authenticated statement of authorship. A rumor claiming a different author
  // than the key that signed the seal is rejected with the same generic failure as
  // above, for the same reason: the mismatch must not be distinguishable from a plain
  // decrypt failure.
  if (message.pubkey && message.pubkey !== seal.pubkey) {
    throw new Error("Failed to decrypt seal");
  }
  return { message, senderPubkey: seal.pubkey };
}

/**
 * NIP-17 recommends randomizing gift-wrap + seal `created_at` timestamps
 * within ±2 days of `now` so traffic-analysis can't link wraps to a
 * specific user-action time.
 */
function randomTimestampInPast(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDays = 2 * 24 * 3600;
  return now - Math.floor(Math.random() * twoDays);
}
