---
"@nostr-wot/identity": minor
"@nostr-wot/vault": minor
---

Support derived and stored passkeys as defined by the passkey key modes proposal: derived keys from host-configured parameter sets (`deriveNostrKey`), tagged user handles (`classifyPasskeyHandle`), stored `key`, `seed` and `vault` records (`encryptStoredRecord`, `openStoredRecord`, `saveStoredRecord`, `storedPayloadKeys`), and `resolvePasskeyIdentity`, which never derives a key from a stored passkey and returns `ambiguous` when nothing proves the mode. `restoreRecovery` now classifies the user handle instead of reading it as a public key, and finds untagged credentials by credential ID. Provider and transport additions are optional.
