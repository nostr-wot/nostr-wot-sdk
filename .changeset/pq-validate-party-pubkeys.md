---
'@nostr-wot/pq': patch
---

Validate party pubkeys in the post-quantum envelope.

The associated data joins both party pubkeys with `:`, and nothing checked what those strings contained. Two distinct conversations could therefore produce byte-identical associated data: a payload sealed as `{ sender: 'aaaa:bbbb', recipient: 'cccc' }` opens cleanly under `{ sender: 'aaaa', recipient: 'bbbb:cccc' }` — defeating exactly the property the envelope advertises, that a ciphertext cannot be replayed into another conversation or have its direction swapped.

`encryptPq` and `decryptPq` now require both parties to be 64 lowercase hex characters. A patch rather than a minor bump because this changes no wire bytes and rejects nothing a conforming implementation would send.

Case is checked for a second reason: uppercase hex produces different associated data, so it would interoperate with nothing. Rejecting it turns a message no other client can read into a loud failure at the boundary instead of a silent one.

The check sits inside `decryptPq`'s existing try, so a malformed party still surfaces as the single generic `Decryption failed` rather than a distinct error an attacker could use as an oracle.
