---
"@nostr-wot/signers": major
---

BREAKING: Remove dead adapters and unused types.

- Removed the NDK adapter module (`ndkSignerAsNostrSigner`, `nostrSignerAsNdkSigner`, and all `Ndk*` types).
- Removed the NIP-55 external-signer skeleton (`Nip55Signer`, `Nip55Bridge`) which had no working transport and zero consumers.
- Removed the unused `SignerCapabilities` type.

NIP-07, NIP-46, and in-memory (`PrivateKeySigner`) signers are unchanged.
