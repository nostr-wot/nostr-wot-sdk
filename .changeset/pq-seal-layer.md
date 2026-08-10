---
"@nostr-wot/pq": minor
---

Move the post-quantum envelope from the rumor layer to the seal layer, cutting gift-wrapped message size by 16-28%.

NIP-59 base64-encodes at every layer, so anything in the rumor is expanded by 4/3 three times over. Placing the envelope one layer out removes an entire expansion of the 1568-byte ML-KEM ciphertext — 2,048 bytes saved on a 280-character message.

A framing optimisation, not a cryptographic one. Nothing is weakened, and the seal is arguably the more natural home, since it is already where NIP-59 puts the rumor's confidentiality.
