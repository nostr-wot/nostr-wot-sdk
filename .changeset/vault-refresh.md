---
"@nostr-wot/vault": minor
---

Add portable version 2 passkey vault records, bounded recovery-file parsing, and interoperable HKDF/AES-GCM wrapping with scoped key access. Keep password vault records compatible, reject unsupported protection modes, and retain passkey enrollment during password saves and changes.

Add memory-only active-account clearing with scoped-capability revocation, serialized cleanup that deletes only an authenticated empty vault, and seed-relationship removal warnings that never expose seed material.
