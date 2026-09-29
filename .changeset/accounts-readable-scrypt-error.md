---
"@nostr-wot/accounts": patch
---

A scrypt derivation this build cannot perform now throws `Could not derive a key from this backup's scrypt parameters`, with the library's own error attached as `cause`, instead of letting the library's internal message through.

Hosts render `error.message` in front of the user, so the `maxmem` regression showed people holding an unreadable key backup the string `"maxmem" limit was hit: memUsed(128*r*(N+p+1))=67110912`. The message is deliberately not the wrong-password one: a backup that cannot be stretched at all is a different problem from a password that does not match, and sending someone to retype a password that was right sends them nowhere.

Ported from the browser extension's `c7d0ec8`.
