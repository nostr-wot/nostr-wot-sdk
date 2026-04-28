# @nostr-wot/relay

Standalone Nostr relay utilities: pool management, query batching, stats. Extracted from the WoT SDK so any Nostr project can use them without pulling in WoT scoring code.

## Install

```bash
npm i @nostr-wot/relay nostr-tools
```

## Use

```ts
import { RelayPool, QueryBatcher, RelayStats } from '@nostr-wot/relay';
```

React hooks: `import { … } from '@nostr-wot/relay/react'`.

See the source for the API surface (this package is a low-level building block — most apps don't need it directly; reach for `@nostr-wot/data` first).

## License

MIT
