---
"@nostr-wot/vault": minor
---

`hasMnemonic(accountId)`: whether an account holds a seed phrase, false while locked, revealing nothing, as `hasImportedPqKeys` does.

`withDerivedSecrets(secrets, fn)`: the scoped accessor for a secret the vault never stored — keys a caller derived from a mnemonic it does hold. The buffers are registered in the same live-key set `withPrivkey`'s copy goes in, so one `lock()` zeroes them mid-callback rather than whenever the callback happens to finish, and a result computed under a session that moved is voided.
