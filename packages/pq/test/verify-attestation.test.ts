/**
 * `verifyAttestation`: the whole check a recipient of someone else's kind:10203 needs.
 *
 * `parseAttestation` is explicit that it does not verify the event's secp256k1 signature.
 * A caller that forgets is trusting tags anyone could have published under any pubkey, so
 * this is the one function to call on an event fetched from a relay: kind, signature, then
 * the tags.
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { randomBytes } from '@noble/hashes/utils.js';
import { buildAttestationTags, derivePqKeys, verifyAttestation, PQC_KIND } from '../src/index.js';

function signedAttestation(kind = PQC_KIND) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const { kem, dsa } = derivePqKeys(randomBytes(64), 0);
  const event = finalizeEvent(
    {
      kind,
      created_at: 1_700_000_000,
      content: '',
      tags: buildAttestationTags({ pubkey, kem: kem.publicKey, dsa: dsa.publicKey, origin: 'derived', dsaSecretKey: dsa.secretKey }),
    },
    sk,
  );
  // As a relay serves it: plain JSON, without the verified mark `finalizeEvent` leaves on
  // the object it returns, which a spread would otherwise carry onto a forgery.
  return { event: JSON.parse(JSON.stringify(event)) as typeof event, pubkey, kem };
}

describe('verifyAttestation', () => {
  it('accepts a signed attestation and hands back the KEM key', () => {
    const { event, pubkey, kem } = signedAttestation();
    const result = verifyAttestation(event);
    expect(result.usable).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.pubkey).toBe(pubkey);
    expect(result.kem).toEqual(kem.publicKey);
  });

  it('refuses an event whose signature does not verify, whatever its tags say', () => {
    const { event } = signedAttestation();
    const forged = { ...event, pubkey: getPublicKey(generateSecretKey()) };
    const result = verifyAttestation(forged);
    expect(result.usable).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('badSignature');
    expect(result.kem).toBeNull();
  });

  it('refuses an event of another kind, however well formed', () => {
    const { event } = signedAttestation(1);
    const result = verifyAttestation(event);
    expect(result.usable).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('wrongKind');
    expect(result.kem).toBeNull();
  });

  it('still reports the tag problems parseAttestation would', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent({ kind: PQC_KIND, created_at: 1, content: '', tags: [] }, sk);
    const result = verifyAttestation(event);
    expect(result.usable).toBe(false);
    expect(result.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['noAlgTags', 'noKem']));
  });
});
