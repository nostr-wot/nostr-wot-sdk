/**
 * Post-quantum direct messages.
 *
 * Composes the envelope with NIP-17 and NIP-59. The rumor is carried inside the
 * post-quantum envelope, which becomes the `content` of the kind:13 seal; the seal is
 * gift-wrapped in a kind:1059 with an ephemeral key, unchanged.
 *
 * The envelope sits at the *seal* layer rather than inside the rumor, and that choice is
 * worth 16-28% of the wire size. NIP-59 base64-encodes at every layer, so anything placed
 * in the rumor is expanded by 4/3 three times over. Putting the envelope one layer out
 * removes an entire expansion of the 1568-byte ML-KEM ciphertext — measured at 2048 bytes
 * saved on a 280-character message. It is also the more natural place: the seal is
 * already where NIP-59 puts the rumor's confidentiality, so this replaces that layer's
 * encryption rather than adding a fourth one.
 *
 * The consequence is the point: a post-quantum message is, to every relay and to every
 * client that has not implemented this, an ordinary NIP-59 gift wrap. Nothing needs to
 * be upgraded for these to traverse the network today.
 *
 * The outer layers stay secp256k1, which is a deliberate and stated limit — see the
 * README. A quantum adversary can forge the wrapper; they cannot read the payload.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
  type Event,
  type EventTemplate,
  type UnsignedEvent,
} from 'nostr-tools';

import { encryptPq, decryptPq, isPqEnvelope } from './envelope.js';

/** NIP-59 / NIP-17 kinds, unchanged. */
export const KIND_RUMOR = 14;
export const KIND_SEAL = 13;
export const KIND_GIFT_WRAP = 1059;

/** Marks a rumor as post-quantum, for clients that inspect it after decryption. */
export const PQ_TAG = ['encrypted', 'nip-pqc/v1'];

/**
 * Randomise timestamps up to two days in the past, per NIP-59, so wrap timing does not
 * correlate with send timing.
 */
function randomPastTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);
}

export interface CreatePqDmInput {
  content: string;
  /** Sender's secp256k1 secret key. */
  senderSecretKey: Uint8Array;
  /** Recipient's secp256k1 x-only pubkey, hex. */
  recipientPubkey: string;
  /** Recipient's ML-KEM-1024 encapsulation key, from their kind:10203 attestation. */
  recipientKemKey: Uint8Array;
  /** Extra tags on the rumor (e.g. a subject, or a reply reference). */
  tags?: string[][];
}

/**
 * Build a gift-wrapped post-quantum direct message.
 *
 * @deprecated Use `@nostr-wot/dm`'s `sealAndGiftWrap` with the signer's `{ scheme: 'pq',
 * recipientKemKey }` option instead. Transport (gift-wrapping, relay filters) belongs in
 * `@nostr-wot/dm`, not here, and key material belongs in the signer layer
 * (`@nostr-wot/signers`), not in a function that takes a raw secret key — this pair forces a
 * consumer to hand-compose two packages instead of going through the signer that already owns
 * the key. Kept for backward compatibility: it is published public API and its wire format is
 * pinned by a cross-implementation vector test against the Rust port in the Dart NDK, so it is
 * not being removed or changed.
 * @returns the kind:1059 event to publish. Publish it to the recipient's inbox relays.
 */
export function createPqDirectMessage(input: CreatePqDmInput): Event {
  const senderPubkey = getPublicKey(input.senderSecretKey);

  // The classic half of the hybrid: the ordinary NIP-44 conversation key.
  const conversationKey = nip44.getConversationKey(input.senderSecretKey, input.recipientPubkey);

  // The rumor is unsigned by design (NIP-59): it must not be independently verifiable.
  const rumor: UnsignedEvent = {
    kind: KIND_RUMOR,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', input.recipientPubkey], PQ_TAG, ...(input.tags ?? [])],
    content: input.content,
  };

  // The whole rumor goes inside the post-quantum envelope, and the envelope IS the seal's
  // content — replacing the seal's NIP-44 encryption rather than nesting inside it.
  const payload = encryptPq(JSON.stringify(rumor), input.recipientKemKey, conversationKey, {
    sender: senderPubkey,
    recipient: input.recipientPubkey,
  });

  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: randomPastTimestamp(),
      tags: [],
      content: payload,
    } as EventTemplate,
    input.senderSecretKey,
  );

  // The wrap is signed by a throwaway key, so the sender's identity is not on the outside.
  const ephemeral = generateSecretKey();
  const wrapKey = nip44.getConversationKey(ephemeral, input.recipientPubkey);

  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomPastTimestamp(),
      tags: [['p', input.recipientPubkey]],
      content: nip44.encrypt(JSON.stringify(seal), wrapKey),
    } as EventTemplate,
    ephemeral,
  );
}

export interface OpenedPqDm {
  /** Sender's secp256k1 pubkey, taken from the *sealed* layer, never the wrapper. */
  sender: string;
  content: string;
  createdAt: number;
  tags: string[][];
}

export interface OpenPqDmInput {
  wrap: Event;
  /** Recipient's secp256k1 secret key. */
  recipientSecretKey: Uint8Array;
  /** Recipient's ML-KEM-1024 secret key. */
  recipientKemSecretKey: Uint8Array;
}

/**
 * Unwrap and decrypt a gift-wrapped post-quantum direct message.
 *
 * Rejects the message if the seal's signature does not verify, or if the rumor claims a
 * different author than the key that signed the seal. That second check is the one worth
 * having: without it, anyone could wrap a rumor claiming to be from someone else, and the
 * recipient would display it as genuine.
 *
 * @deprecated Use `@nostr-wot/dm`'s `unwrapGiftWrap` instead — `signer.nip44Decrypt` auto-routes
 * to post-quantum decryption on its own, so a signer-based caller needs no separate function
 * for this. Transport belongs in `@nostr-wot/dm`, not here, and key material belongs in the
 * signer layer (`@nostr-wot/signers`), not in a function that takes raw secret keys directly —
 * this pair forces a consumer to hand-compose two packages instead of going through the signer
 * that already owns the key. Kept for backward compatibility: it is published public API and
 * its wire format is pinned by a cross-implementation vector test against the Rust port in the
 * Dart NDK, so it is not being removed or changed.
 * @returns the message, or null if this wrap is not a post-quantum message for us.
 * @throws on a wrap that is malformed or fails authentication.
 */
export function openPqDirectMessage(input: OpenPqDmInput): OpenedPqDm | null {
  const recipientPubkey = getPublicKey(input.recipientSecretKey);

  const wrapKey = nip44.getConversationKey(input.recipientSecretKey, input.wrap.pubkey);
  const seal = JSON.parse(nip44.decrypt(input.wrap.content, wrapKey)) as Event;

  if (seal.kind !== KIND_SEAL) throw new Error('Not a seal');
  if (!verifyEvent(seal)) throw new Error('Seal signature does not verify');

  // A classic NIP-17 seal carries a NIP-44 payload, not ours. Not an error — just not
  // for us to handle, and a post-quantum client must not choke on ordinary messages.
  if (!isPqEnvelope(seal.content)) return null;

  const conversationKey = nip44.getConversationKey(input.recipientSecretKey, seal.pubkey);
  const rumor = JSON.parse(
    decryptPq(seal.content, input.recipientKemSecretKey, conversationKey, {
      sender: seal.pubkey,
      recipient: recipientPubkey,
    }),
  ) as UnsignedEvent;

  if (rumor.kind !== KIND_RUMOR) return null;

  // The rumor is unsigned, so its `pubkey` is only a claim. The seal's signature is the
  // actual authentication — they must agree, or anyone could wrap a rumor attributed to
  // someone else and have the recipient display it as genuine.
  if (rumor.pubkey !== seal.pubkey) throw new Error('Rumor author does not match seal');

  return {
    sender: rumor.pubkey,
    content: rumor.content,
    createdAt: rumor.created_at,
    tags: rumor.tags,
  };
}

/** Filter for fetching gift wraps addressed to us. */
export function inboxFilter(pubkey: string, since?: number) {
  return since === undefined
    ? { kinds: [KIND_GIFT_WRAP], '#p': [pubkey] }
    : { kinds: [KIND_GIFT_WRAP], '#p': [pubkey], since };
}
