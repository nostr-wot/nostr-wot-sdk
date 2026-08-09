---
"@nostr-wot/pq": minor
---

Add the post-quantum message envelope: hybrid ML-KEM-1024 + NIP-44 sealed with XChaCha20-Poly1305, riding inside NIP-59 gift wrap unchanged.

Self-describing and version-prefixed rather than overloading NIP-44's version registry. Framing is authenticated (both pubkeys and the algorithm byte are in the AEAD's associated data), length is padded with NIP-44's scheme, and every decryption failure throws one generic error.
