# @nostr-wot/pq

## 0.2.2

### Patch Changes

- [#7](https://github.com/nostr-wot/nostr-wot-sdk/pull/7) [`113c956`](https://github.com/nostr-wot/nostr-wot-sdk/commit/113c956a8f9ef2f6c84b72cc299163753951860c) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Mark `createPqDirectMessage` and `openPqDirectMessage` as `@deprecated`. No behavior change — both functions keep working exactly as before, and their wire format stays pinned by the cross-implementation vector test against the Rust port in the Dart NDK.

  They predate the signer-layer post-quantum support added in `@nostr-wot/signers` and duplicate NIP-17 gift-wrap logic that now lives in `@nostr-wot/dm`. Using them means composing two packages by hand and passing a raw secret key to a function outside the signer that's supposed to own it. Prefer `@nostr-wot/dm`'s `sealAndGiftWrap` / `unwrapGiftWrap` with the signer's `{ scheme: 'pq', recipientKemKey }` option instead: transport belongs in `@nostr-wot/dm`, key material belongs in `@nostr-wot/signers`, and `@nostr-wot/pq` stays what it was always meant to be — pure primitives, no transport, no keys.

## 0.2.1

### Patch Changes

- [#5](https://github.com/nostr-wot/nostr-wot-sdk/pull/5) [`e6ba9df`](https://github.com/nostr-wot/nostr-wot-sdk/commit/e6ba9dfca9636dfa065441d4cd8375e3de60a45a) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Validate party pubkeys in the post-quantum envelope.

  The associated data joins both party pubkeys with `:`, and nothing checked what those strings contained. Two distinct conversations could therefore produce byte-identical associated data: a payload sealed as `{ sender: 'aaaa:bbbb', recipient: 'cccc' }` opens cleanly under `{ sender: 'aaaa', recipient: 'bbbb:cccc' }` — defeating exactly the property the envelope advertises, that a ciphertext cannot be replayed into another conversation or have its direction swapped.

  `encryptPq` and `decryptPq` now require both parties to be 64 lowercase hex characters. A patch rather than a minor bump because this changes no wire bytes and rejects nothing a conforming implementation would send.

  Case is checked for a second reason: uppercase hex produces different associated data, so it would interoperate with nothing. Rejecting it turns a message no other client can read into a loud failure at the boundary instead of a silent one.

  The check sits inside `decryptPq`'s existing try, so a malformed party still surfaces as the single generic `Decryption failed` rather than a distinct error an attacker could use as an oracle.

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
