# @nostr-wot/signer-core

## 0.3.0

### Minor Changes

- [#14](https://github.com/nostr-wot/nostr-wot-sdk/pull/14) [`e480f70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/e480f7065aeb1b181ff2335f0e56d2df3c0f271d) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Validate destination authentication at the signing boundary, require explicit individual consent even for remote accounts, and revalidate policy, account, timestamp and revocation before releasing signatures. Add opt-in, host-configured legacy login compatibility with one-time warning metadata. Authentication approval adapters must now return authenticationScope: once; generic batch authentication is refused.

### Patch Changes

- Updated dependencies [[`4d24073`](https://github.com/nostr-wot/nostr-wot-sdk/commit/4d24073f29c732d253bf1a2ef3aa2d051971deec), [`9439868`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9439868eeefd6d18dc504c313354dadfd3bfe77e), [`3f866fa`](https://github.com/nostr-wot/nostr-wot-sdk/commit/3f866fa3192e1870bf202ec7714af0f438ee32e7)]:
  - @nostr-wot/permissions@0.3.0
  - @nostr-wot/signers@1.2.3
  - @nostr-wot/vault@0.3.0

## 0.2.0

### Minor Changes

- [`78f4aa2`](https://github.com/nostr-wot/nostr-wot-sdk/commit/78f4aa2e91e96e4ae5ed8fc32ec900813bf724fc) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Post-quantum support, held to the browser extension's behaviour. `withPqKeys` is the one scoped path to an account's ML-KEM-1024 and ML-DSA-87 keys (imported first, else derived from a 24-word seed at the account's derivation path; zeroed on every path, voided on a moved session). `nip44Decrypt` routes on the self-describing envelope: hybrid, classic, or a clean `operation_failed`. `nip44Encrypt` seals hybrid only on `opts: { scheme: 'pq', recipientKemKey }`, never inferred. `signPqAttestation` signs the account's `kind:10203` through the pipeline under the `signEvent` rule for kind 10203, building the event before the prompt and presenting it as a `signEvent` request so a host's event preview shows what is being signed instead of a bare method name; for that method the unlock therefore runs before the prompt. `verifyPqAttestation` checks someone else's. A remote account is refused for post-quantum before the bunker sees it. A batch now yields a real macrotask between items, so it is no longer one contiguous block of CPU: the longest unbroken stretch of a 64-item post-quantum batch falls from 1.4 s to 26 ms on Node arm64, for about 1 ms per item. The validated NIP-44 params carry a required `scheme`; activity entries for NIP-44 methods carry it too. A post-quantum decrypt also carries `envelope: 'hybrid' | 'unreadable'`, and a payload whose header names the hybrid envelope but which cannot be opened is refused as post-quantum, with that in the error and in the activity entry, instead of being routed classic and mislabelled there. `atob` and `btoa` are now declared host requirements of the shared packages, since `@nostr-wot/pq`'s base64 helpers reach for them.

### Patch Changes

- Updated dependencies [[`2bf5a21`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2bf5a21cc9ff2c091b3d5357fc8904e6ab11aebc), [`02a88b6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/02a88b6a717773751d0b850571dbff0921a68acf), [`f984cb6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/f984cb65f965456503a8627ffa6dc9c3e55f028c), [`302f897`](https://github.com/nostr-wot/nostr-wot-sdk/commit/302f897e5e1bc854ef5ad8a07433b15c513ea996), [`feae7ff`](https://github.com/nostr-wot/nostr-wot-sdk/commit/feae7ff79175d10033b785c15081e24ab42208c6), [`78f4aa2`](https://github.com/nostr-wot/nostr-wot-sdk/commit/78f4aa2e91e96e4ae5ed8fc32ec900813bf724fc)]:
  - @nostr-wot/accounts@0.1.1
  - @nostr-wot/permissions@0.2.0
  - @nostr-wot/pq@0.3.0
  - @nostr-wot/vault@0.2.0
  - @nostr-wot/signers@1.2.1
