---
"@nostr-wot/identity": patch
"nostr-wot-sdk": patch
---

Read explicit Nosskey account backups with their original PRF inputs and direct or NIP-44 wrapped-key format, verifying the recovered identity without guessing a credential's mode.

Add an independently implemented Nosskey iframe protocol signer with pinned origin/frame/account, signature verification, request timeouts and explicit teardown.
