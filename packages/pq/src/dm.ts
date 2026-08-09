/**
 * Post-quantum direct messages.
 *
 * Composes the envelope with NIP-17 and NIP-59 exactly as they already exist. The
 * post-quantum payload becomes the `content` of the kind:14 rumor; the rumor is sealed
 * in a kind:13 and gift-wrapped in a kind:1059 with an ephemeral key, unchanged.
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

/** Marks a rumor whose content is a post-quantum envelope, so a client knows to try. */
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
 * @returns the kind:1059 event to publish. Publish it to the recipient's inbox relays.
 */
export function createPqDirectMessage(input: CreatePqDmInput): Event {
  const senderPubkey = getPublicKey(input.senderSecretKey);

  // The classic half of the hybrid: the ordinary NIP-44 conversation key.
  const conversationKey = nip44.getConversationKey(input.senderSecretKey, input.recipientPubkey);

  const payload = encryptPq(input.content, input.recipientKemKey, conversationKey, {
    sender: senderPubkey,
    recipient: input.recipientPubkey,
  });

  // The rumor is unsigned by design (NIP-59): it must not be independently verifiable.
  const rumor: UnsignedEvent & { id?: string } = {
    kind: KIND_RUMOR,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', input.recipientPubkey], PQ_TAG, ...(input.tags ?? [])],
    content: payload,
  };

  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: randomPastTimestamp(),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), conversationKey),
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
 * @returns the message, or null if this wrap is not a post-quantum message for us.
 * @throws on a wrap that is malformed or fails authentication.
 */
export function openPqDirectMessage(input: OpenPqDmInput): OpenedPqDm | null {
  const recipientPubkey = getPublicKey(input.recipientSecretKey);

  const wrapKey = nip44.getConversationKey(input.recipientSecretKey, input.wrap.pubkey);
  const seal = JSON.parse(nip44.decrypt(input.wrap.content, wrapKey)) as Event;

  if (seal.kind !== KIND_SEAL) throw new Error('Not a seal');
  if (!verifyEvent(seal)) throw new Error('Seal signature does not verify');

  const sealKey = nip44.getConversationKey(input.recipientSecretKey, seal.pubkey);
  const rumor = JSON.parse(nip44.decrypt(seal.content, sealKey)) as UnsignedEvent;

  if (rumor.kind !== KIND_RUMOR) return null;

  // The rumor is unsigned, so its `pubkey` is only a claim. The seal's signature is the
  // actual authentication — they must agree.
  if (rumor.pubkey !== seal.pubkey) throw new Error('Rumor author does not match seal');

  if (!isPqEnvelope(rumor.content)) return null;

  const conversationKey = nip44.getConversationKey(input.recipientSecretKey, rumor.pubkey);
  const content = decryptPq(rumor.content, input.recipientKemSecretKey, conversationKey, {
    sender: rumor.pubkey,
    recipient: recipientPubkey,
  });

  return {
    sender: rumor.pubkey,
    content,
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
