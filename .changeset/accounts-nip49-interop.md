---
"@nostr-wot/accounts": patch
---

NIP-49 is now verified against an independent implementation in both directions.

Every other ncryptsec test in this package decodes with its own decoder or builds a payload from its own reading of the layout, so a systematic encoder error, a wrong offset, the AAD omitted, the password normalized differently, would round-trip happily through all of them. `test/nip49-interop.test.ts` round-trips through `nostr-tools` instead, across every `key_security_byte` the spec defines and cost factors either side of the one this package writes. Tests only; no runtime change.

Ported from the browser extension's `tests/crypto/nip49.test.ts`. Upstream commit `c7d0ec8`,
"Fix NIP-49 scrypt bounds and guard dependency compatibility", is where it landed; that SHA
no longer resolves from the extension's `main`, which was squashed and force-rewritten, so
the file is the reference and the commit is provenance only.
