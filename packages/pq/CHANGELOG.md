# @nostr-wot/pq

## 0.2.0

### Minor Changes

- [#3](https://github.com/nostr-wot/nostr-wot-sdk/pull/3) [`0315d6e`](https://github.com/nostr-wot/nostr-wot-sdk/commit/0315d6eff84bdc120f2d61d34814d6c6f511a130) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add post-quantum direct messages: `createPqDirectMessage` / `openPqDirectMessage`.

  Composes the envelope with NIP-17 and NIP-59 unchanged — the post-quantum payload is the content of a kind:14 rumor, sealed in a kind:13 and gift-wrapped in a kind:1059 with an ephemeral key. To a relay, and to any client that has not implemented this, it is an ordinary gift wrap.

  Authenticates the sealed author against the seal's signature, so a forged rumor claiming someone else's authorship is rejected rather than displayed as genuine.

- [#3](https://github.com/nostr-wot/nostr-wot-sdk/pull/3) [`0315d6e`](https://github.com/nostr-wot/nostr-wot-sdk/commit/0315d6eff84bdc120f2d61d34814d6c6f511a130) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add the post-quantum message envelope: hybrid ML-KEM-1024 + NIP-44 sealed with XChaCha20-Poly1305, riding inside NIP-59 gift wrap unchanged.

  Self-describing and version-prefixed rather than overloading NIP-44's version registry. Framing is authenticated (both pubkeys and the algorithm byte are in the AEAD's associated data), length is padded with NIP-44's scheme, and every decryption failure throws one generic error.

- [#3](https://github.com/nostr-wot/nostr-wot-sdk/pull/3) [`0315d6e`](https://github.com/nostr-wot/nostr-wot-sdk/commit/0315d6eff84bdc120f2d61d34814d6c6f511a130) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add `@nostr-wot/pq`: post-quantum identity keys for Nostr.

  Derives ML-KEM-1024 and ML-DSA-87 keys from a NIP-06 seed as siblings of the secp256k1 key, and builds, parses and verifies the `kind:10203` attestation that advertises them.

  New leaf package, so nothing existing changes and the `@noble/post-quantum` dependency stays out of every other package.

- [#3](https://github.com/nostr-wot/nostr-wot-sdk/pull/3) [`0315d6e`](https://github.com/nostr-wot/nostr-wot-sdk/commit/0315d6eff84bdc120f2d61d34814d6c6f511a130) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Move the post-quantum envelope from the rumor layer to the seal layer, cutting gift-wrapped message size by 16-28%.

  NIP-59 base64-encodes at every layer, so anything in the rumor is expanded by 4/3 three times over. Placing the envelope one layer out removes an entire expansion of the 1568-byte ML-KEM ciphertext — 2,048 bytes saved on a 280-character message.

  A framing optimisation, not a cryptographic one. Nothing is weakened, and the seal is arguably the more natural home, since it is already where NIP-59 puts the rumor's confidentiality.
