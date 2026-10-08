---
"@nostr-wot/dm": minor
---

Add self-addressed gift-wrap helpers for private application state. These reuse the existing signer-based NIP-59 encryption and authenticated unwrap path, reject other authors in mixed inbox streams, and preserve the inner rumor timestamp independently of randomized envelope timestamps.

Expose NIP-17 attachment encryption and decryption with fresh AES-GCM keys/nonces, ciphertext and plaintext hashes, and integrity errors for tampered or malformed files. WebCrypto is resolved only when these async functions are called.
