# @nostr-wot/accounts

## 0.1.1

### Patch Changes

- [`2bf5a21`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2bf5a21cc9ff2c091b3d5357fc8904e6ab11aebc) Thanks [@leonacostaok](https://github.com/leonacostaok)! - NIP-49 is now verified against an independent implementation in both directions.

  Every other ncryptsec test in this package decodes with its own decoder or builds a payload from its own reading of the layout, so a systematic encoder error, a wrong offset, the AAD omitted, the password normalized differently, would round-trip happily through all of them. `test/nip49-interop.test.ts` round-trips through `nostr-tools` instead, across every `key_security_byte` the spec defines and cost factors either side of the one this package writes. Tests only; no runtime change.

  Ported from the browser extension's `tests/crypto/nip49.test.ts`. Upstream commit `c7d0ec8`,
  "Fix NIP-49 scrypt bounds and guard dependency compatibility", is where it landed; that SHA
  no longer resolves from the extension's `main`, which was squashed and force-rewritten, so
  the file is the reference and the commit is provenance only.

- [`02a88b6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/02a88b6a717773751d0b850571dbff0921a68acf) Thanks [@leonacostaok](https://github.com/leonacostaok)! - A scrypt derivation this build cannot perform now throws `Could not derive a key from this backup's scrypt parameters`, with the library's own error attached as `cause`, instead of letting the library's internal message through.

  Hosts render `error.message` in front of the user, so the `maxmem` regression showed people holding an unreadable key backup the string `"maxmem" limit was hit: memUsed(128*r*(N+p+1))=67110912`. The message is deliberately not the wrong-password one: a backup that cannot be stretched at all is a different problem from a password that does not match, and sending someone to retype a password that was right sends them nowhere.

  Ported from the browser extension's `deriveScryptKey` in `src/lib/crypto/nip49.ts`, which
  throws the same string from the same catch. Upstream commit `c7d0ec8` is where it landed;
  that SHA no longer resolves from the extension's `main`, so it is provenance only.

- [`f984cb6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/f984cb65f965456503a8627ffa6dc9c3e55f028c) Thanks [@leonacostaok](https://github.com/leonacostaok)! - `scryptMaxMem` now sits `SCRYPT_MAXMEM_SLACK_BLOCKS` (4) blocks clear of what the algorithm needs, instead of exactly on `@noble/hashes` 2.4.0's internal accounting.

  The bound was `128·r·(N + p + 1)`, which is 2.4.0's expression character for character. That was the repair for an earlier bound of `128·r·(N + p)`, which is 2.0.1's expression character for character and threw `"maxmem" limit was hit` on every `encryptNcryptsec` and `decryptNcryptsec` once a version in range resolved. The repair moved the coupling one version along rather than removing it, and left zero blocks spare, so the next noble that charges one more block takes the NIP-49 backup and import path out again for anyone who resolves from the declared `^2.4.0` rather than a lockfile.

  `test/scrypt-maxmem.test.ts` binary-searches the installed library for the smallest `maxmem` it accepts and requires the bound to clear it with headroom, so a noble that raises its charge is found one release before it breaks anybody. `SCRYPT_MAXMEM_SLACK_BLOCKS` is exported.

  `deriveScryptKey` also computes `N` as `2 ** logN` rather than `1 << logN`, matching `scryptMaxMem`, so the two cannot diverge if `MAX_LOG_N` is ever raised past 30.

  Ported from the browser extension's `scryptMaxMem` and `SCRYPT_MAXMEM_SLACK_BLOCKS`, in
  `src/lib/crypto/nip49.ts` and `src/constants/crypto/nip49.ts`. Upstream commit `c7d0ec8` is
  where it landed; that SHA no longer resolves from the extension's `main`, so it is
  provenance only.
