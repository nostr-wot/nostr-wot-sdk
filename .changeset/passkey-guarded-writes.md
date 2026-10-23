---
"@nostr-wot/identity": patch
---

Keep signed new-format vaults eligible regardless of unrelated tag sizes so malformed newest records cannot silently fall back to older vaults. Require a provider storage read and explicit overwrite confirmation for nonempty passkey blobs. Release the passkey changes on the `next` prerelease channel while cross-client and real-device acceptance remain pending.
