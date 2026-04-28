# @nostr-wot/wot

Web-of-Trust scoring + browser-extension bridge for Nostr. Computes hop distance between npubs, derives trust scores, and integrates with the [Nostr WoT browser extension](https://nostr-wot.com/) for client-side WoT queries.

## Install

```bash
npm i @nostr-wot/wot
```

React: `import { ... } from '@nostr-wot/wot/react'` (provides `<WoTProvider>` + `<NostrSdkProvider>` + hooks).
Solid: `import { ... } from '@nostr-wot/wot/solid'`.

## Use

```ts
import { WoT } from '@nostr-wot/wot';

const wot = new WoT({ /* options */ });
const result = await wot.getDistance('hex-pubkey');
// → { hops, paths, score } | null
```

React, with the unified provider:

```tsx
import { NostrSdkProvider, useTrustScore } from '@nostr-wot/wot/react';

<NostrSdkProvider
  relays={['wss://relay.damus.io', 'wss://nos.lol']}
  wot={{ enabled: true, options: { extensionId: 'abc' } }}
>
  <App />
</NostrSdkProvider>
```

`<NostrSdkProvider>` is the recommended top-level provider for any app using the SDK. It configures the data layer (relays, profile aggregators, cache) and optionally enables WoT context. WoT hooks (`useWoT`, `useTrustScore`, `useIsInWoT`, `useBatchWoT`) require either `wot.enabled: true` here or a separate `<WoTProvider>`.

## License

MIT
