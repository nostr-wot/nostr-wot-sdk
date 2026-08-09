import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, nip44, verifyEvent } from 'nostr-tools';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  derivePqKeys, createPqDirectMessage, openPqDirectMessage, inboxFilter,
  KIND_GIFT_WRAP, KIND_SEAL, KIND_RUMOR,
} from '../src/index.js';

/**
 * A full identity: a secp256k1 key plus post-quantum keys.
 *
 * Uses a random 64-byte seed rather than a mnemonic — the derivation itself is covered
 * against the NIP-06 vectors in pq.test.ts, and this file is about the message flow.
 */
function identity() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), pq: derivePqKeys(randomBytes(64), 0) };
}

describe('post-quantum direct messages', () => {
  it('round-trips end to end', () => {
    const alice = identity();
    const bob = identity();

    const wrap = createPqDirectMessage({
      content: 'the whole point of the exercise',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
    });

    const opened = openPqDirectMessage({
      wrap,
      recipientSecretKey: bob.sk,
      recipientKemSecretKey: bob.pq.kem.secretKey,
    });

    expect(opened).not.toBeNull();
    expect(opened!.content).toBe('the whole point of the exercise');
    expect(opened!.sender).toBe(alice.pk);
  });

  it('the wrap is an ordinary, valid NIP-59 gift wrap', () => {
    // If this fails, relays would reject it and the "no relay changes" claim is false.
    const alice = identity();
    const bob = identity();
    const wrap = createPqDirectMessage({
      content: 'hi',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
    });

    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(verifyEvent(wrap)).toBe(true);
    expect(wrap.tags).toContainEqual(['p', bob.pk]);
    expect(wrap.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('the sender is not identifiable from the outside', () => {
    const alice = identity();
    const bob = identity();
    const wrap = createPqDirectMessage({
      content: 'anonymous on the wire',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
    });

    expect(wrap.pubkey).not.toBe(alice.pk);
    expect(JSON.stringify(wrap)).not.toContain(alice.pk);
  });

  it('a third party cannot open it', () => {
    const alice = identity();
    const bob = identity();
    const mallory = identity();
    const wrap = createPqDirectMessage({
      content: 'not for mallory',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
    });

    expect(() =>
      openPqDirectMessage({
        wrap,
        recipientSecretKey: mallory.sk,
        recipientKemSecretKey: mallory.pq.kem.secretKey,
      }),
    ).toThrow();
  });

  it('the right secp256k1 key alone is not enough — the PQ key is load-bearing', () => {
    // Bob's classic key unwraps the gift wrap and the seal, but the payload still
    // needs his ML-KEM key. If this passed, the post-quantum layer would be decorative.
    const alice = identity();
    const bob = identity();
    const other = identity();
    const wrap = createPqDirectMessage({
      content: 'needs both halves',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
    });

    expect(() =>
      openPqDirectMessage({
        wrap,
        recipientSecretKey: bob.sk,
        recipientKemSecretKey: other.pq.kem.secretKey,
      }),
    ).toThrow(/Decryption failed/);
  });

  it('rejects a rumor claiming an author the seal did not sign', () => {
    // Forge attempt: mallory seals a rumor that claims to be from alice.
    const alice = identity();
    const bob = identity();
    const mallory = identity();

    const rumor = {
      kind: KIND_RUMOR,
      pubkey: alice.pk, // the lie
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', bob.pk]],
      content: 'trust me, this is from alice',
    };

    const mConv = nip44.getConversationKey(mallory.sk, bob.pk);
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: nip44.encrypt(JSON.stringify(rumor), mConv),
      },
      mallory.sk,
    );
    const eph = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', bob.pk]],
        content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, bob.pk)),
      },
      eph,
    );

    expect(() =>
      openPqDirectMessage({
        wrap,
        recipientSecretKey: bob.sk,
        recipientKemSecretKey: bob.pq.kem.secretKey,
      }),
    ).toThrow(/does not match seal/);
  });

  it('returns null for a non-post-quantum gift wrap rather than throwing', () => {
    // A plain NIP-17 message must not blow up a post-quantum-aware client.
    const alice = identity();
    const bob = identity();
    const conv = nip44.getConversationKey(alice.sk, bob.pk);
    const rumor = {
      kind: KIND_RUMOR,
      pubkey: alice.pk,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', bob.pk]],
      content: 'an ordinary classic message',
    };
    const seal = finalizeEvent(
      { kind: KIND_SEAL, created_at: Math.floor(Date.now() / 1000), tags: [], content: nip44.encrypt(JSON.stringify(rumor), conv) },
      alice.sk,
    );
    const eph = generateSecretKey();
    const wrap = finalizeEvent(
      { kind: KIND_GIFT_WRAP, created_at: Math.floor(Date.now() / 1000), tags: [['p', bob.pk]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, bob.pk)) },
      eph,
    );

    expect(
      openPqDirectMessage({
        wrap,
        recipientSecretKey: bob.sk,
        recipientKemSecretKey: bob.pq.kem.secretKey,
      }),
    ).toBeNull();
  });

  it('carries extra tags through to the recipient', () => {
    const alice = identity();
    const bob = identity();
    const wrap = createPqDirectMessage({
      content: 'threaded',
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pq.kem.publicKey,
      tags: [['subject', 'migration']],
    });
    const opened = openPqDirectMessage({
      wrap,
      recipientSecretKey: bob.sk,
      recipientKemSecretKey: bob.pq.kem.secretKey,
    });
    expect(opened!.tags).toContainEqual(['subject', 'migration']);
  });

  it('two sends of the same text produce unlinkable wraps', () => {
    const alice = identity();
    const bob = identity();
    const mk = () =>
      createPqDirectMessage({
        content: 'identical text',
        senderSecretKey: alice.sk,
        recipientPubkey: bob.pk,
        recipientKemKey: bob.pq.kem.publicKey,
      });
    const a = mk();
    const b = mk();
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(a.content).not.toBe(b.content);
    expect(a.id).not.toBe(b.id);
  });
});

describe('inboxFilter', () => {
  it('targets gift wraps addressed to us', () => {
    expect(inboxFilter('ab'.repeat(32))).toEqual({
      kinds: [KIND_GIFT_WRAP],
      '#p': ['ab'.repeat(32)],
    });
    expect(inboxFilter('ab'.repeat(32), 100)).toHaveProperty('since', 100);
  });
});
