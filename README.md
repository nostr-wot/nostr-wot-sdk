# nostr-wot-sdk

JavaScript/TypeScript SDK for querying Nostr Web of Trust.

## Install
```bash
npm install nostr-wot-sdk
```

## Quick Start

### With Browser Extension (Recommended)

Install the [Nostr WoT Extension](https://github.com/nostr-wot/nostr-wot-extension) for the best experience. The extension downloads your follow graph locally and works across all websites.

```javascript
import { WoT } from 'nostr-wot-sdk';

// Extension mode - no pubkey needed, uses extension's data
const wot = new WoT({
  useExtension: true,
  fallback: {
    oracle: 'https://nostr-wot.com',
    myPubkey: 'abc123...'  // Used only if extension unavailable
  }
});

// Check distance
const hops = await wot.getDistance('def456...');
console.log(hops); // 2

// Boolean check
const trusted = await wot.isInMyWoT('def456...', { maxHops: 3 });
console.log(trusted); // true

// Trust score
const score = await wot.getTrustScore('def456...');
console.log(score); // 0.72
```

When the extension is installed, **it always takes priority** — the SDK uses the extension's pubkey and locally-cached follow graph automatically.

### Without Extension (Oracle Mode)

```javascript
import { WoT } from 'nostr-wot-sdk';

const wot = new WoT({
  oracle: 'https://nostr-wot.com',
  myPubkey: 'abc123...'  // Required in oracle-only mode
});

const hops = await wot.getDistance('def456...');
```

## Features

- **Extension-First** — Automatically uses browser extension when available
- **Simple API** — Three methods cover most use cases
- **Cross-Site Trust** — Extension provides same WoT data on all websites
- **Offline Support** — Extension caches data locally for offline queries
- **Custom Scoring** — Define your own trust weights
- **Batch Queries** — Check multiple pubkeys efficiently
- **TypeScript** — Full type definitions included

## API Reference

### Constructor
```javascript
const wot = new WoT(options);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `useExtension` | boolean | `false` | Use browser extension if available (recommended) |
| `oracle` | string | `'https://nostr-wot.com'` | Oracle API URL (fallback) |
| `myPubkey` | string | — | Your pubkey (optional with extension, required otherwise) |
| `maxHops` | number | `3` | Default max search depth |
| `timeout` | number | `5000` | Request timeout (ms) |
| `scoring` | object | See below | Trust score weights |
| `fallback` | object | — | Fallback config when extension unavailable |

**Note:** When `useExtension: true` and the extension is installed, the extension's pubkey and data are always used, regardless of `myPubkey` or `oracle` settings.

### Methods

#### `getDistance(target, options?)`

Get shortest path length to target pubkey.
```javascript
const hops = await wot.getDistance('def456...');
// Returns: number | null
```

#### `isInMyWoT(target, options?)`

Check if target is within your Web of Trust.
```javascript
const trusted = await wot.isInMyWoT('def456...', { maxHops: 2 });
// Returns: boolean
```

#### `getTrustScore(target, options?)`

Get computed trust score based on distance and weights.
```javascript
const score = await wot.getTrustScore('def456...');
// Returns: number (0-1)
```

#### `getDistanceBetween(from, to, options?)`

Get distance between any two pubkeys.
```javascript
const hops = await wot.getDistanceBetween('abc...', 'def...');
// Returns: number | null
```

#### `batchCheck(targets, options?)`

Check multiple pubkeys efficiently.
```javascript
const results = await wot.batchCheck(['pk1...', 'pk2...', 'pk3...']);
// Returns: Map<string, BatchResult>
```

#### `getDetails(target, options?)`

Get distance and path count details.
```javascript
const details = await wot.getDetails('def456...');
// Returns: { hops: 2, paths: 5 }
// Oracle may also return: bridges, mutual
```

#### `getMyPubkey()`

Get the current pubkey (from extension or fallback).
```javascript
const pubkey = await wot.getMyPubkey();
// Returns: string
```

#### `isUsingExtension()`

Check if extension is available and being used.
```javascript
const usingExt = await wot.isUsingExtension();
// Returns: boolean
```

#### `getExtensionConfig()`

Get extension's configuration (only when using extension).
```javascript
const config = await wot.getExtensionConfig();
// Returns: { maxHops: 3, timeout: 5000, scoring: {...} } or null
```

### Batch Operations

#### `getDistanceBatch(targets)`

Get distances for multiple pubkeys in a single call.
```javascript
const distances = await wot.getDistanceBatch(['pk1...', 'pk2...']);
// Returns: { 'pk1...': 2, 'pk2...': null }
```

#### `getTrustScoreBatch(targets)`

Get trust scores for multiple pubkeys in a single call.
```javascript
const scores = await wot.getTrustScoreBatch(['pk1...', 'pk2...']);
// Returns: { 'pk1...': 0.72, 'pk2...': null }
```

#### `filterByWoT(pubkeys, options?)`

Filter a list of pubkeys to only those within the Web of Trust.
```javascript
const trusted = await wot.filterByWoT(['pk1...', 'pk2...', 'pk3...']);
// Returns: ['pk1...', 'pk3...'] (only those in WoT)
```

### Graph Queries (Extension-only)

These methods require the browser extension and return `null`/empty when unavailable.

#### `getFollows(pubkey?)`

Get the follow list for a pubkey (defaults to your pubkey).
```javascript
const follows = await wot.getFollows();
// Returns: ['pk1...', 'pk2...', ...]
```

#### `getCommonFollows(pubkey)`

Get mutual follows between you and a target.
```javascript
const common = await wot.getCommonFollows('def456...');
// Returns: ['pk1...', 'pk2...'] (people you both follow)
```

#### `getPath(target)`

Get the actual path from you to a target.
```javascript
const path = await wot.getPath('def456...');
// Returns: ['myPubkey', 'friend', 'friendOfFriend', 'def456...']
```

#### `getStats()`

Get graph statistics.
```javascript
const stats = await wot.getStats();
// Returns: { nodes: 50000, edges: 150000, lastSync: 1699999999, size: '12 MB' }
```

#### `isConfigured()`

Check if the extension is configured and ready.
```javascript
const status = await wot.isConfigured();
// Returns: { configured: true, mode: 'local', hasLocalGraph: true }
```

## Browser Extension

Install the [Nostr WoT Extension](https://github.com/nostr-wot/nostr-wot-extension) for:

- **Local Data** — Downloads and caches your follow graph locally
- **Fast Queries** — No network requests needed after sync
- **Cross-Site** — Same WoT data available on all websites
- **Privacy** — Queries never leave your browser
- **Offline** — Works without internet once synced

The SDK automatically detects `window.nostr.wot` and uses it. When the extension is present, it **always takes priority** over oracle settings.

```javascript
const wot = new WoT({
  useExtension: true,
  fallback: {
    oracle: 'https://nostr-wot.com',
    myPubkey: 'abc123...'
  }
});

// Check if using extension
if (await wot.isUsingExtension()) {
  console.log('Using local extension data');
} else {
  console.log('Falling back to oracle');
}
```

## Custom Scoring

Define how trust scores are calculated:
```javascript
const wot = new WoT({
  useExtension: true,
  scoring: {
    // Distance weights (score multiplier per hop)
    distanceWeights: {
      1: 1.0,    // Direct follows
      2: 0.5,    // 2 hops
      3: 0.25,   // 3 hops
      4: 0.1,    // 4+ hops
    },
    // Bonus multipliers
    mutualBonus: 0.5,      // +50% for mutual follows
    pathBonus: 0.1,        // +10% per additional path
    maxPathBonus: 0.5,     // Cap path bonus at +50%
  }
});
```

### Scoring Formula
```
score = baseScore × distanceWeight × (1 + bonuses)

where:
  baseScore = 1 / (hops + 1)
  bonuses = mutualBonus (if mutual) + min(pathBonus × (paths - 1), maxPathBonus)
```

## Server-Side Local Mode

For Node.js/server environments where the browser extension isn't available:

```javascript
import { LocalWoT } from 'nostr-wot-sdk/local';

const wot = new LocalWoT({
  myPubkey: 'abc123...',
  relays: ['wss://relay.damus.io', 'wss://nos.lol']
});

// Sync follow graph (2 hops from your pubkey)
await wot.sync({ depth: 2 });

// Now queries run locally
const hops = await wot.getDistance('def456...');
```

Storage options: `'memory'` (default), `'indexeddb'` (browser), or custom adapter.

## Framework Integration

### React
```javascript
import { useWoT, WoTProvider } from 'nostr-wot-sdk/react';

// Wrap your app with the provider
function App() {
  return (
    <WoTProvider options={{ useExtension: true }}>
      <YourApp />
    </WoTProvider>
  );
}

// Use hooks in components
function Profile({ pubkey }) {
  const { distance, score, loading } = useWoT(pubkey);

  if (loading) return <Spinner />;

  return (
    <div>
      {distance !== null ? (
        <span>{distance} hops away (score: {score.toFixed(2)})</span>
      ) : (
        <span>Not in your network</span>
      )}
    </div>
  );
}
```

## TypeScript

Full type definitions included:
```typescript
import { WoT, DistanceResult, WoTOptions } from 'nostr-wot-sdk';

const options: WoTOptions = { useExtension: true };
const wot = new WoT(options);
const result: DistanceResult | null = await wot.getDetails(pubkey);
const score: number = await wot.getTrustScore(pubkey);
```

## Error Handling
```javascript
import { WoT, WoTError, NetworkError, NotFoundError } from 'nostr-wot-sdk';

try {
  const hops = await wot.getDistance('def456...');
} catch (e) {
  if (e instanceof NetworkError) {
    console.log('Oracle unreachable');
  } else if (e instanceof NotFoundError) {
    console.log('Pubkey not in graph');
  }
}
```

## Related

- [Nostr WoT Extension](https://github.com/nostr-wot/nostr-wot-extension) — Browser extension (recommended)
- [WoT Oracle](https://github.com/nostr-wot/nostr-wot-oracle) — Backend service
- [nostr-wot.com](https://nostr-wot.com) — Public oracle & docs

## License

MIT
