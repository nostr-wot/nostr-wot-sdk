# nostr-wot-sdk

> **This package is a back-compat meta re-export.** New code should depend on the scoped packages directly.

| Old import | New import |
|---|---|
| `nostr-wot-sdk` | `@nostr-wot/wot` |
| `nostr-wot-sdk/react` | `@nostr-wot/wot/react` + `@nostr-wot/data/react` |
| `nostr-wot-sdk/solid` | `@nostr-wot/wot/solid` |
| `nostr-wot-sdk/relay` | `@nostr-wot/relay` |
| `nostr-wot-sdk/relay/react` | `@nostr-wot/relay/react` |
| `nostr-wot-sdk/data` | `@nostr-wot/data` |
| `nostr-wot-sdk/data/cache` | `@nostr-wot/data/cache` |

Existing imports keep working — this package just re-exports the scoped packages so older consumers don't break. It will continue to be published in lock-step with `@nostr-wot/*` minor releases.

For new projects, install only the scoped package(s) you actually need:

```bash
npm i @nostr-wot/data           # event fetchers + cache + hooks
npm i @nostr-wot/wot            # WoT scoring + browser-extension bridge
npm i @nostr-wot/relay          # low-level relay utilities
```

See [the monorepo README](https://github.com/nostr-wot/nostr-wot-sdk) for architecture and per-package docs.
