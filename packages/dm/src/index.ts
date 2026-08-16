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
 * messages.
 *
 * This package touches no post-quantum key material and does not depend on
 * `@nostr-wot/pq` — it only ever passes an `opts` bag through to
 * `signer.nip44Encrypt`/`signer.nip44Decrypt`. The signer (`@nostr-wot/signers`)
 * is the layer that owns key material, so it's the layer that owns post-quantum
 * sealing: `PrivateKeySigner` performs the hybrid encryption/decryption directly,
 * and `Nip07Signer` forwards the request to the browser extension
 * (`window.nostr.nip44.encrypt(pubkey, plaintext, { scheme: 'pq', recipientKemKey })`),
 * which is what makes this work for extension- and bunker-held keys, not only
 * keys held directly in process memory.
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
 * Post-quantum sealing input for `sealAndGiftWrap`. Passed straight through as
 * `signer.nip44Encrypt`'s third argument — the signer (not this package) owns the
 * key material and performs the hybrid encryption.
 */
export interface PqSealOptions {
  scheme: "pq";
  /**
   * Recipient's ML-KEM-1024 encapsulation key, base64-encoded, from their
   * kind:10203 attestation.
   */
  recipientKemKey: string;
}

export interface SealAndGiftWrapOptions {
  /**
   * Seal with a post-quantum envelope instead of plain NIP-44. The seal's
   * `content` becomes the envelope; everything outside the seal — kind, tags,
   * timestamps, the gift wrap itself — is unchanged, so a relay or a client that
   * hasn't implemented this still sees an ordinary kind-1059.
   *
   * `sealAndGiftWrap` never touches key material for this: it hands `pq` straight
   * to `signer.nip44Encrypt` as its third argument, and the signer performs the
   * hybrid encryption. A signer without post-quantum support throws rather than
   * silently sealing with plain NIP-44.
   */
  pq?: PqSealOptions;
}

/**
 * Wrap a chat message per NIP-17:
 *   1. Hash the inner unsigned event id (NIP-01 standard hash).
 *   2. Encrypt the inner event JSON with NIP-44 between sender and recipient —
 *      or, in post-quantum mode, ask the signer to seal it with
 *      `@nostr-wot/pq`'s hybrid envelope instead — into the "seal" (kind 13,
 *      signed by sender).
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
  if (!signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption (needed for NIP-17)");
  }

  // Inner event id (no signature; per NIP-17 the inner event is unsigned)
  const innerWithId = { ...message, id: getEventHash(message as UnsignedEvent) };

  // Seal: kind 13, sender signs, NIP-44 to recipient — or, with `options.pq`,
  // the signer's post-quantum path. Either way the signer does the crypto; this
  // function only decides which mode to ask for.
  const sealedContent = await signer.nip44Encrypt(
    recipientPubkey,
    JSON.stringify(innerWithId),
    options.pq,
  );
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
 * Reverse of `sealAndGiftWrap`. Given a kind-1059 gift wrap addressed to
 * us, returns the inner unsigned chat message + the sender pubkey
 * (recovered from the seal's signature).
 *
 * Takes no post-quantum option and needs none: `signer.nip44Decrypt` auto-routes
 * on its own — the post-quantum envelope is self-describing
 * (`@nostr-wot/pq`'s `isPqEnvelope`), so the signer detects it and decrypts
 * accordingly. That means a single conversation can freely mix classic and
 * post-quantum messages, and every existing caller of `unwrapGiftWrap`
 * (`cache/inbox.ts`, `cache/backfill.ts`) already gets post-quantum support for
 * free, with no changes on their part, as long as the signer supports it.
 *
 * Throws if the gift wrap can't be decrypted or the seal kind/sig is
 * invalid.
 */
export async function unwrapGiftWrap(
  signer: NostrSigner,
  giftWrap: Event,
): Promise<{ message: UnsignedEvent & { id: string }; senderPubkey: string }> {
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption (needed for NIP-17)");
  }
  if (giftWrap.kind !== KIND_GIFT_WRAP) {
    throw new Error(`Expected kind ${KIND_GIFT_WRAP}, got ${giftWrap.kind}`);
  }
  // Decrypt the wrap (ephemeral pubkey is giftWrap.pubkey)
  const wrapPlaintext = await signer.nip44Decrypt(giftWrap.pubkey, giftWrap.content);
  const seal = JSON.parse(wrapPlaintext) as Event;
  if (seal.kind !== KIND_SEALED) {
    throw new Error(`Expected sealed kind ${KIND_SEALED}, got ${seal.kind}`);
  }
  // The seal's signature is checked alongside its decryption below, both folded into
  // the same generic failure: a caller must not be able to tell, from the error alone,
  // whether the seal failed to decrypt or merely failed to verify. Applies equally
  // whichever way `nip44Decrypt` routed internally.
  if (!verifyEvent(seal)) {
    throw new Error("Failed to decrypt seal");
  }
  // Decrypt the seal (sender is seal.pubkey). Auto-routes to post-quantum
  // decryption inside the signer when the content is a post-quantum envelope.
  const sealPlaintext = await signer.nip44Decrypt(seal.pubkey, seal.content);
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
