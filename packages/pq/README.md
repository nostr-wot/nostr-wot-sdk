# @nostr-wot/pq

Post-quantum identity keys for Nostr.

Derives ML-KEM-1024 and ML-DSA-87 keys from a NIP-06 seed, and builds, parses and
verifies the `kind:10203` attestation that advertises them.

```bash
npm install @nostr-wot/pq
```

## Why

A Nostr public key is published to every relay it touches, and Shor's algorithm recovers a
private key from a public key. Two harms follow, with very different deadlines:

- **Encrypted messages become readable retroactively.** NIP-44 derives its conversation key
  from an ECDH secret between two secp256k1 keys, so anyone archiving encrypted events today
  can decrypt them all once secp256k1 falls.
- **Events can be forged.** Worse in impact, but it cannot be pre-empted — only fixed by
  migrating signatures before the break.

Only the first can be fixed *in advance*, which is what this package addresses.

## The idea: siblings, not children

The obvious design — deriving the post-quantum key *from* the Nostr private key — is
circular. An adversary who recovers `nsec` from `npub` runs the same derivation and gets the
post-quantum key too.

Instead both keys are derived **from the same BIP-39 seed, independently**:

```
kem_seed = HKDF-SHA256(seed, info = "nip-pqc/v1/ml-kem-1024/<account>", 64)
dsa_seed = HKDF-SHA256(seed, info = "nip-pqc/v1/ml-dsa-87/<account>",  32)
```

BIP-32 and HKDF are one-way, so recovering the secp256k1 private key reveals nothing about
the seed and therefore nothing about the post-quantum keys. One mnemonic still restores
everything.

> `derivePqKeys` takes the **seed**, not a private key. Passing a private key produces
> different, unrelated keys and defeats the entire design.

## Usage

### Derive keys

```ts
import { mnemonicToSeedSync } from '@scure/bip39';
import { derivePqKeys } from '@nostr-wot/pq';

const seed = mnemonicToSeedSync(mnemonic); // 24 words
const { kem, dsa } = derivePqKeys(seed, 0);
```

### Publish an attestation

```ts
import { buildAttestationTags, PQC_KIND } from '@nostr-wot/pq';
import { finalizeEvent } from 'nostr-tools';

const event = finalizeEvent({
  kind: PQC_KIND,
  created_at: Math.floor(Date.now() / 1000),
  content: '',
  tags: buildAttestationTags({
    pubkey, kem: kem.publicKey, dsa: dsa.publicKey,
    origin: 'derived', dsaSecretKey: dsa.secretKey,
  }),
}, secretKey);
```

`origin: 'derived'` asserts that one mnemonic restores these keys, so it is only valid from
a 256-bit (24-word) seed. Anything weaker must be published as `'independent'` and backed up
separately.

### Check whether someone can receive post-quantum messages

```ts
import { attestationFilter, parseAttestation, encapsulate, hybridKey } from '@nostr-wot/pq';
import { verifyEvent } from 'nostr-tools';

const event = await pool.get(relays, attestationFilter([theirPubkey]));
if (!event || !verifyEvent(event)) return; // verify the signature yourself first

const att = parseAttestation(event);
if (!att.usable) {
  console.warn('not usable:', att.problems); // typed codes, not prose
  return;
}

const { cipherText, sharedSecret } = encapsulate(att.kem!);
const key = hybridKey(sharedSecret, nip44ConversationKey);
```

`parseAttestation` is strict on purpose. A malformed or unproven attestation returns
`usable: false` with an explicit problem list rather than being partially accepted — the
failure worth engineering against is a sender *believing* a recipient is reachable
post-quantum when they are not.

`parseAttestation` does **not** verify the event's secp256k1 signature. Do that yourself.

## Proof of possession

A secp256k1 signature over the attestation proves the identity published those bytes, not
that it holds the post-quantum keys. So the ML-DSA key counter-signs a message binding the
npub and both keys together. ML-KEM cannot sign, which is why this is also what gives the
encapsulation key its possession proof.

## Hybrid, not replacement

`hybridKey` combines the KEM secret with the classic NIP-44 conversation key through a KDF,
so the result is no weaker than either input. The post-quantum secret must never be used
alone: a flaw in a comparatively young lattice scheme must not be able to make Nostr
messaging *worse* than it is today.

## The message envelope

A self-describing payload carrying an ML-KEM-1024 ciphertext and an
XChaCha20-Poly1305-sealed message. It fits anywhere a string does — in practice as the
`content` of a NIP-17 kind:14 rumor, sealed and gift-wrapped per NIP-59 **with no change
to either**. Relays need no changes and clients that have not implemented it are
unaffected.

```ts
import { encryptPq, decryptPq } from '@nostr-wot/pq';

const parties = { sender: myPubkey, recipient: theirPubkey };

const payload = encryptPq('hello', att.kem!, nip44ConversationKey, parties);
const text    = decryptPq(payload, myKem.secretKey, nip44ConversationKey, parties);
```

### Wire format

```
version   1 byte    0x01
alg       1 byte    0x01 = ML-KEM-1024 + NIP-44 conversation key, XChaCha20-Poly1305
kem_ct    1568      ML-KEM-1024 ciphertext
nonce     24        XChaCha20-Poly1305 nonce
sealed    variable  AEAD(padded plaintext), includes the 16-byte tag
```

base64-encoded for transport.

### Why it looks like this

- **Its own version byte, not NIP-44's.** Overloading NIP-44's version registry would
  squat a number its authors own. This envelope is self-describing, so it can be adopted,
  renumbered or superseded without colliding with anyone.
- **Hybrid, never bare.** The KEM secret is combined with the NIP-44 conversation key
  through HKDF, so the result is no weaker than either input. Two tests assert this
  actually binds: a wrong conversation key fails, and a wrong ML-KEM key fails. If either
  passed, the construction would not be hybrid.
- **The framing is authenticated.** Version, algorithm and both pubkeys go into the AEAD's
  associated data, so a ciphertext cannot be replayed into another conversation, have its
  direction swapped, or have its algorithm byte downgraded.
- **Length is padded** using NIP-44's scheme, so ciphertext size does not leak message
  size on a public relay. Messages of 1, 2, 20 and 32 bytes all produce identical wire
  sizes.
- **One generic error.** Every decryption failure throws the same message. Distinguishing
  bad padding from a bad tag from a wrong key hands an attacker an oracle.

### Measured cost

| plaintext | wire (base64) |
|---|---|
| 10 B | 2192 B |
| 100 B | 2320 B |
| 1 KB | 3516 B |
| 10 KB | 15804 B |

Roughly **2.1 KB constant overhead**, almost all of it the ML-KEM ciphertext.
**1.27 ms to encrypt, 1.60 ms to decrypt** a 280-byte message (Node 20, Apple silicon,
average of 100).

## What this does not do

- **It does not stop event forgery.** Events are still signed with secp256k1. A quantum
  adversary can sign as any user, and can publish a replacement attestation carrying their
  own keys to intercept future messages. This makes *past* messages permanently
  confidential; it does not protect future messages once secp256k1 is broken.
- **It does not hide metadata beyond what gift wrap already hides.** Who talks to whom, and
  when, is a NIP-59 question, not this envelope's.

## Parameter sets

ML-KEM-1024 and ML-DSA-87 (NIST Category 5) — the sets mandated by NSA CNSA 2.0. Australia's
ISM withdraws approval for ML-KEM-768 and ML-DSA-65 after 2030, so the smaller sets would
mean shipping parameters already scheduled for withdrawal.

## References

- [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final) — ML-KEM
- [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) — ML-DSA
- [NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md) — seed derivation
- [nips#1971](https://github.com/nostr-protocol/nips/issues/1971) — the discussion this responds to

## License

MIT
