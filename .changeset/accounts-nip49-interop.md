---
"@nostr-wot/accounts": patch
---

NIP-49 is now verified against an independent implementation in both directions.

Every other ncryptsec test in this package decodes with its own decoder or builds a payload from its own reading of the layout, so a systematic encoder error, a wrong offset, the AAD omitted, the password normalized differently, would round-trip happily through all of them. `test/nip49-interop.test.ts` round-trips through `nostr-tools` instead, across every `key_security_byte` the spec defines and cost factors either side of the one this package writes. Tests only; no runtime change.

Ported from the browser extension's `c7d0ec8`.
