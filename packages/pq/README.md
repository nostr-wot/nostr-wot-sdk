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

## What this does not do

- **It does not stop event forgery.** Events are still signed with secp256k1. A quantum
  adversary can sign as any user, and can publish a replacement attestation carrying their
  own keys to intercept future messages. This makes *past* messages permanently
  confidential; it does not protect future messages once secp256k1 is broken.
- **It defines no encryption payload format.** That belongs to a separate specification.
  This package answers "whose key, and how do you find it".

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
