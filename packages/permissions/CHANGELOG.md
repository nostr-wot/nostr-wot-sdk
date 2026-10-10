# @nostr-wot/permissions

## 0.3.0

### Minor Changes

- [#14](https://github.com/nostr-wot/nostr-wot-sdk/pull/14) [`4d24073`](https://github.com/nostr-wot/nostr-wot-sdk/commit/4d24073f29c732d253bf1a2ef3aa2d051971deec) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add true global rules, account/site inheritance, resumable conservative migrations, and explicit reset/inherit operations while preserving legacy storage behavior until migration. Add host-configured, once-only legacy login parsing and account opt-in backend authentication with exact registry matching and deny precedence.

## 0.2.0

### Minor Changes

- [`302f897`](https://github.com/nostr-wot/nostr-wot-sdk/commit/302f897e5e1bc854ef5ad8a07433b15c513ea996) Thanks [@leonacostaok](https://github.com/leonacostaok)! - First release of `@nostr-wot/permissions`, the authorization layer every `@nostr-wot` signer funnels through.

  One question, asked identically by every transport: may this caller sign this, encrypt this, decrypt this. NIP-07 in an extension, NIP-55 from an Android app and NIP-46 from a remote signer differ in how a request arrives, not in who may make it, so the decision lives here once instead of three times.

  Two halves. `resolve`, `resolveDetailed`, `permissionKey` and `consultedKeys` are pure: given a bucket of stored decisions they produce `allow`, `deny` or `ask`, and the cascade's guarantee is that **deny wins**. Three levels are consulted, kind-specific then method then wildcard, and an explicit deny at any of them ends the matter, so no narrower allow reopens what a broader rule refused. The security critical part is therefore testable with no storage at all. `Permissions` is the other half: buckets per origin and account over an injected `KeyValueStore`, an in-memory cache, a lock around every read-modify-write, and the migration that reads a browser extension's existing `signerPermissions` blob unchanged, keeping a blanket deny so a remembered refusal survives the upgrade.

  What the shape of the API is for, rather than how it happens to be spelled:

  - **The DM kinds collapse.** `signEvent` of kind 4, 13, 14 or 1059 and the NIP-04/44 encrypt methods all key to `sendMessages`, so one approval covers a whole send-a-DM flow instead of prompting twice. `saveDirect` throws on a raw `signEvent:4` rather than storing a rule that can never fire.
  - **Per-account mode fails closed.** A missing or empty `accountId` resolves to no bucket: `check` answers `ask` and a write throws, rather than landing in the shared `_default` bucket as the extension's `accountId || '_default'` does. With four transports feeding one package, an optional parameter that one call site forgets is how a cross-account leak ships.
  - **Origins are canonicalised here, not by the host.** `canonicalHttpOrigin` and `canonicalHostname` lowercase scheme and host, drop a default port, write IPv4 and IPv6 one way, and refuse credentials or a path. React Native's `URL` folds neither case nor ports, so a check built on `new URL(x).origin === x` would let `https://EXAMPLE.COM` and `https://example.com:443` keep separate rules on a phone.
  - **An authentication event is a credential, not a publication.** A kind-22242 (NIP-42) or kind-27235 (NIP-98) event is addressed to the relay or service in its `relay` or `u` tag, which a permission keyed by method and kind cannot express: a remembered `signEvent:22242 = allow` is a credential for every relay a caller later names (GHSA-vx4h-56qj-wcp7). So those get their own five-part question through `parseAuthentication` and `AuthenticationGrants`. A NIP-42 grant is keyed by the canonical relay URL; a NIP-98 grant by the exact signed URL, query bytes included and nothing normalised, because someone shown `POST /login` did not consent to `POST /transfer`. Pre-endpoint-scoping records (no `version: 2`, no `resource`) never have their `allow` honoured again and are re-asked at the narrower scope, while a legacy `deny` keeps its broad reach. A stored `signEvent:22242` allow never authorises anything. `Permissions` owns the grant store rather than taking one, so clearing an origin or an account cannot leave its credentials behind.
  - **Every mutating method throws on an empty origin, key or account id.** `''` type-checks wherever a label belongs and means nothing, so it is a caller bug: notably `clear('')` does not mean wipe everything. Reads stay tolerant, because a check that throws into a signing path is worse than one that prompts.

  Platform-neutral: no framework, no browser or React Native global, enforced by the repository's ESLint boundary and `packages/vault/test/boundaries.test.ts`. ESM only; the README says what that means for a CommonJS caller.

### Patch Changes

- Updated dependencies [[`302f897`](https://github.com/nostr-wot/nostr-wot-sdk/commit/302f897e5e1bc854ef5ad8a07433b15c513ea996)]:
  - @nostr-wot/storage@0.2.0
