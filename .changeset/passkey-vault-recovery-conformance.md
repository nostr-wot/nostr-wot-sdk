---
"@nostr-wot/identity": patch
---

Align tagged passkey recovery with the split key/vault proposal: use provisional kind 31778 without a version tag for new records, normalize seed writes to vaults, and preserve legacy reads. Validate strict vault JSON, skip unusable accounts, select the first usable default, compare provider and newest relay vault timestamps, and report source failures through an optional recovery callback. Credential-specific relay queries and conservative handle recovery prevent unrelated records or missing recovery data from selecting a different identity.
