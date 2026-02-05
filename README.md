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

// The SDK automatically uses the extension when available
const wot = new WoT({
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

// Trust score (from extension)
const score = await wot.getTrustScore('def456...');
console.log(score); // 0.72
```

When the extension is installed, **it always takes priority** — the SDK uses the extension's pubkey and locally-cached follow graph automatically.

### Without Extension (Oracle Fallback)

```javascript
import { WoT } from 'nostr-wot-sdk';

const wot = new WoT({
  oracle: 'https://nostr-wot.com',
  myPubkey: 'abc123...'  // Required for oracle fallback
});

const hops = await wot.getDistance('def456...');
```

## Features

- **Extension-First** — Automatically uses browser extension when available
- **Simple API** — Three methods cover most use cases
- **Cross-Site Trust** — Extension provides same WoT data on all websites
- **Offline Support** — Extension caches data locally for offline queries
- **Batch Queries** — Check multiple pubkeys efficiently
- **TypeScript** — Full type definitions included

## API Reference

### Constructor
```javascript
const wot = new WoT(options);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `oracle` | string | `'https://nostr-wot.com'` | Oracle API URL (fallback when extension unavailable) |
| `myPubkey` | string | — | Your pubkey (optional - fetched from extension when available) |
| `maxHops` | number | `3` | Default max search depth |
| `timeout` | number | `5000` | Request timeout (ms) |
| `fallback` | object | — | Fallback config when extension unavailable |

Trust scores are calculated by the extension and not configurable via the SDK.

**Note:** When the extension is installed, it always takes priority over `myPubkey` or `oracle` settings.

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

#### `getTrustScore(target)`

Get computed trust score from the extension.
```javascript
const score = await wot.getTrustScore('def456...');
// Returns: number (0-1), or 0 if extension unavailable
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

Get extension's configuration.
```javascript
const config = await wot.getExtensionConfig();
// Returns: { maxHops: 3, timeout: 5000, scoring: {...} } or null
```

### Batch Operations

#### `getDistanceBatch(targets, includePaths?)`

Get distances for multiple pubkeys in a single call.
```javascript
// Without paths (faster, default)
const distances = await wot.getDistanceBatch(['pk1...', 'pk2...']);
// Returns: { 'pk1...': 2, 'pk2...': null }

// With paths (includes path count for scoring)
const details = await wot.getDistanceBatch(['pk1...', 'pk2...'], true);
// Returns: { 'pk1...': { hops: 2, paths: 5 }, 'pk2...': null }
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

The SDK automatically detects and connects to the extension using an event-based handshake. When the extension is present, it **always takes priority** over oracle settings.

```javascript
const wot = new WoT({
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

### Extension Connection Utilities

For advanced use cases, the SDK exports low-level extension connection functions:

```javascript
import {
  checkExtension,     // Check if extension is installed
  connectExtension,   // Connect to the extension
  checkAndConnect,    // Check and connect in one call
  ExtensionConnector  // Stateful connector class
} from 'nostr-wot-sdk';

// Check if extension is installed (100ms timeout)
const isInstalled = await checkExtension();

// Connect to extension (5s timeout)
const extension = await connectExtension();

// Or do both in one call
const result = await checkAndConnect();
if (result.state === 'connected') {
  const distance = await result.extension.getDistance('target...');
}

// For stateful connection management
const connector = new ExtensionConnector();
connector.subscribe((result) => {
  console.log('State changed:', result.state);
});
await connector.connect();
```

#### Extension Events

The SDK uses a standard event-based protocol to communicate with the extension:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `nostr-wot-check` | Page → Extension | Check if extension installed |
| `nostr-wot-present` | Extension → Page | Response confirming presence |
| `nostr-wot-connect` | Page → Extension | Request API injection |
| `nostr-wot-ready` | Extension → Page | API is ready at `window.nostr.wot` |
| `nostr-wot-error` | Extension → Page | Injection failed with error |

## Framework Integration

### React

The SDK provides first-class React support with automatic extension detection and connection. Just wrap your app with `WoTProvider` and you're ready to go — no additional configuration needed.

```javascript
import { WoTProvider, useWoT, useExtension } from 'nostr-wot-sdk/react';

// Wrap your app - automatically connects to extension
function App() {
  return (
    <WoTProvider>
      <YourApp />
    </WoTProvider>
  );
}

// Check extension status anywhere
function ExtensionStatus() {
  const { isConnected, isConnecting, isInstalled, error } = useExtension();

  if (isConnecting) return <span>Connecting to extension...</span>;
  if (!isInstalled) return <span>Install the WoT extension for best experience</span>;
  if (error) return <span>Error: {error}</span>;
  if (isConnected) return <span>Connected to extension!</span>;
  return null;
}

// Use WoT data in components
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

#### Provider Options

```javascript
// With fallback for when extension is not installed
<WoTProvider options={{
  fallback: { myPubkey: 'abc123...' }
}}>

// Custom extension connection timeouts
<WoTProvider extensionOptions={{
  checkTimeout: 100,    // Extension detection timeout (ms)
  connectTimeout: 5000  // Connection timeout (ms)
}}>
```

#### Available Hooks

| Hook | Description |
|------|-------------|
| `useWoT(pubkey)` | Get distance, score, and details for a pubkey |
| `useIsInWoT(pubkey)` | Check if pubkey is in your WoT (boolean) |
| `useTrustScore(pubkey)` | Get trust score only |
| `useBatchWoT(pubkeys[])` | Check multiple pubkeys efficiently |
| `useExtension()` | Get extension connection state |
| `useWoTInstance()` | Get raw WoT instance for advanced usage |

#### Extension State

The `useExtension()` hook provides detailed extension status:

```javascript
const {
  state,        // 'idle' | 'checking' | 'connecting' | 'connected' | 'not-installed' | 'error'
  isConnected,  // Extension is connected and ready
  isConnecting, // Currently checking/connecting
  isInstalled,  // Extension is installed (may still be connecting)
  isChecked,    // Initial check complete
  error,        // Error message if connection failed
  connect,      // Function to manually retry connection
} = useExtension();
```

## TypeScript

Full type definitions included:
```typescript
import { WoT, DistanceResult, WoTOptions } from 'nostr-wot-sdk';

const wot = new WoT();
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
