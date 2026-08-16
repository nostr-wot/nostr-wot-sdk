---
'@nostr-wot/signers': minor
---

`NostrSigner.nip44Encrypt` gains an optional third argument, `opts: { scheme: 'pq'; recipientKemKey: string }`, for post-quantum sealing with `@nostr-wot/pq`'s hybrid ML-KEM-1024 + NIP-44 envelope. `nip44Decrypt` needs no new argument: a post-quantum payload is self-describing, so a supporting signer auto-routes to post-quantum decryption without the caller saying which kind of ciphertext it is.

Key material never leaves the signer — this is the whole point of the change. The caller supplies only the recipient's public ML-KEM key (base64); the signer derives the conversation key and performs the hybrid encryption/decryption itself, exactly as it already does for plain NIP-44.

- `PrivateKeySigner` implements both directions directly, and gains a constructor option, `{ pqKem }`, to configure the account's ML-KEM keypair (derive it with `@nostr-wot/pq`'s `derivePqKeys` from the account's BIP-39 seed — never from the secp256k1 secret key itself). Without `pqKem`, decrypting a post-quantum payload throws.
- `Nip07Signer` forwards `opts` to `window.nostr.nip44.encrypt` as a third argument when present, and omits it entirely otherwise, so extensions that predate post-quantum support see the exact two-argument call they have always seen.
- `Nip46Signer` throws when `opts` is given: `nostr-tools`' `BunkerSigner.nip44Encrypt` sends the underlying NIP-46 `nip44_encrypt` request as `[pubkey, plaintext]`, with no channel for the extra parameter, so there is currently nowhere to put it. A signer that can't honor a post-quantum request throws rather than silently downgrading to plain NIP-44.

`@nostr-wot/signers` now depends on `@nostr-wot/pq` for the envelope primitives.
