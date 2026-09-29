---
"@nostr-wot/accounts": patch
---

`scryptMaxMem` now sits `SCRYPT_MAXMEM_SLACK_BLOCKS` (4) blocks clear of what the algorithm needs, instead of exactly on `@noble/hashes` 2.4.0's internal accounting.

The bound was `128·r·(N + p + 1)`, which is 2.4.0's expression character for character. That was the repair for an earlier bound of `128·r·(N + p)`, which is 2.0.1's expression character for character and threw `"maxmem" limit was hit` on every `encryptNcryptsec` and `decryptNcryptsec` once a version in range resolved. The repair moved the coupling one version along rather than removing it, and left zero blocks spare, so the next noble that charges one more block takes the NIP-49 backup and import path out again for anyone who resolves from the declared `^2.4.0` rather than a lockfile.

`test/scrypt-maxmem.test.ts` binary-searches the installed library for the smallest `maxmem` it accepts and requires the bound to clear it with headroom, so a noble that raises its charge is found one release before it breaks anybody. `SCRYPT_MAXMEM_SLACK_BLOCKS` is exported.

`deriveScryptKey` also computes `N` as `2 ** logN` rather than `1 << logN`, matching `scryptMaxMem`, so the two cannot diverge if `MAX_LOG_N` is ever raised past 30.

Ported from the browser extension's `c7d0ec8`.
