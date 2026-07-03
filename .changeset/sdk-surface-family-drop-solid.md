---
"nostr-wot-sdk": major
---

BREAKING: Remove the Solid entrypoint and surface the full `@nostr-wot/*` family.

- Removed `nostr-wot-sdk/solid` (re-exported the deleted `@nostr-wot/wot/solid`) and the `solid-js` peer dependency.
- Added subpath re-exports so the meta actually surfaces the family: `./signers`, `./ui`, `./dm`, `./dm/react`, `./wallet`, `./wallet/react`, `./auth`, `./blossom` (alongside the existing `./relay`, `./relay/react`, `./data`, `./data/cache`). The corresponding scoped packages are now direct dependencies.
