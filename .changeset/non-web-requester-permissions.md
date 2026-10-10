---
"@nostr-wot/permissions": minor
---

Add a typed `AuthenticationRequester` for callers that are not web pages (`nip46`, `nip55`, `lan`, `local`, beside `web`). `parseAuthentication` accepts one in place of the origin string: a `web` requester is parsed exactly as the string is; every other kind cannot prove an origin, so an `origin` or `client-origin` tag refuses the event, the request is cross-origin for both protocols, and legacy login is refused. `authenticationRequesterKey` gives the grant key, the canonical origin for a page and `kind:identifier` otherwise, which can never collide with a web origin in either direction and matches the spelling `@nostr-wot/signer-core`'s `permissionOrigin` already uses, so an existing grant list keyed that way is read unchanged. `AuthenticationGrants.save` now awaits its `assertCurrent` and throws an `AuthenticationDeniedError` (name `AUTHENTICATION_DENIED_ERROR`) when an allow finds a deny in force. The web path is unchanged.
