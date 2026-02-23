# nostr-wot-sdk

JavaScript/TypeScript SDK for querying Nostr Web of Trust. Includes first-class React and SolidJS support.

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
- **Relay Utilities** — Reusable relay pool, query batching, and stats tracking
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
| `extensionId` | string | — | Chrome Web Store extension ID (for detecting "installed but not enabled" state) |

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

Get distance, path count, and score details.
```javascript
const details = await wot.getDetails('def456...');
// Returns: { hops: 2, paths: 5, score: 0.65 }
// Oracle may also return: bridges, mutual (but score will be 0)
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

#### `getExtensionStatus()`

Get detailed extension connection status. Useful for showing appropriate UI based on why the extension isn't working.
```javascript
const status = await wot.getExtensionStatus();
// Returns: 'connected' | 'not-enabled' | 'unavailable' | 'not-browser'
```

| Status | Description |
|--------|-------------|
| `'connected'` | Extension is enabled and working on this domain |
| `'not-enabled'` | Extension is installed but not enabled for this domain |
| `'unavailable'` | Extension is not installed (or using local dev build) |
| `'not-browser'` | Running in SSR/Node.js environment |

**Note:** Detecting `'not-enabled'` requires providing the `extensionId` option.

#### `getExtensionConfig()`

Get extension's configuration.
```javascript
const config = await wot.getExtensionConfig();
// Returns: { maxHops: 3, timeout: 5000, scoring: {...} } or null
```

### Batch Operations

#### `getDistanceBatch(targets, options?)`

Get distances for multiple pubkeys in a single call.
```javascript
// Default (just hops)
const distances = await wot.getDistanceBatch(['pk1...', 'pk2...']);
// Returns: { 'pk1...': 2, 'pk2...': null }

// With paths
const withPaths = await wot.getDistanceBatch(['pk1...', 'pk2...'], { includePaths: true });
// Returns: { 'pk1...': { hops: 2, paths: 5 }, 'pk2...': null }

// With scores
const withScores = await wot.getDistanceBatch(['pk1...', 'pk2...'], { includeScores: true });
// Returns: { 'pk1...': { hops: 2, score: 0.65 }, 'pk2...': null }

// With both
const full = await wot.getDistanceBatch(['pk1...', 'pk2...'], { includePaths: true, includeScores: true });
// Returns: { 'pk1...': { hops: 2, paths: 5, score: 0.65 }, 'pk2...': null }

// Legacy boolean still works (backwards compatible)
const legacy = await wot.getDistanceBatch(['pk1...'], true);  // same as { includePaths: true }
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

The SDK automatically detects the extension via `window.nostr.wot`. When the extension is present (with auto-inject enabled), it **always takes priority** over oracle settings.

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

## Framework Integration

### React

The SDK provides first-class React support with automatic extension detection. Just wrap your app with `WoTProvider` and you're ready to go — no additional configuration needed.

```javascript
import { WoTProvider, useWoT, useExtension } from 'nostr-wot-sdk/react';

// Wrap your app - automatically detects extension
function App() {
  return (
    <WoTProvider>
      <YourApp />
    </WoTProvider>
  );
}

// Check extension status anywhere
function ExtensionStatus() {
  const { isConnected, isChecking } = useExtension();

  if (isChecking) return <span>Checking for extension...</span>;
  if (isConnected) return <span>Extension connected!</span>;
  return <span>Extension not available</span>;
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
// With fallback for when extension is not available
<WoTProvider options={{
  fallback: { myPubkey: 'abc123...' }
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

The `useExtension()` hook provides extension status:

```javascript
const {
  state,        // 'checking' | 'connected' | 'not-available'
  isConnected,  // Extension is connected and ready
  isChecking,   // Currently checking
  isChecked,    // Check complete
  refresh,      // Function to re-check extension availability
} = useExtension();
```

### SolidJS

The SDK also provides SolidJS support with reactive primitives and automatic extension detection. Wrap your app with `WoTProvider` and use `create*` primitives for fine-grained reactivity.

```javascript
import { WoTProvider, useExtension, createWoT } from 'nostr-wot-sdk/solid';

// Wrap your app - automatically detects extension
function App() {
  return (
    <WoTProvider>
      <YourApp />
    </WoTProvider>
  );
}

// Check extension status anywhere
function ExtensionStatus() {
  const ext = useExtension();

  return (
    <Show when={!ext.isChecking()} fallback={<span>Checking...</span>}>
      <Show when={ext.isConnected()} fallback={<span>Extension not available</span>}>
        <span>Extension connected!</span>
      </Show>
    </Show>
  );
}

// Use WoT data in components
function Profile(props: { pubkey: string }) {
  const wot = createWoT(() => props.pubkey);

  return (
    <Show when={!wot.loading()} fallback={<Spinner />}>
      <Show when={wot.distance() !== null} fallback={<span>Not in your network</span>}>
        <span>{wot.distance()} hops away (score: {wot.score().toFixed(2)})</span>
      </Show>
    </Show>
  );
}
```

#### Provider Options

```javascript
// With fallback for when extension is not available
<WoTProvider options={{
  fallback: { myPubkey: 'abc123...' }
}}>
```

#### Available Primitives

| Primitive | Description |
|-----------|-------------|
| `createWoT(pubkey)` | Get distance, score, and details for a pubkey |
| `createIsInWoT(pubkey)` | Check if pubkey is in your WoT (boolean) |
| `createTrustScore(pubkey)` | Get trust score only |
| `createBatchWoT(pubkeys[])` | Check multiple pubkeys efficiently |
| `useExtension()` | Get extension connection state |
| `useWoTInstance()` | Get raw WoT instance for advanced usage |

#### Extension State

The `useExtension()` function provides extension status:

```javascript
const ext = useExtension();

ext.state()        // 'checking' | 'connected' | 'not-available'
ext.isConnected()  // Extension is connected and ready
ext.isChecking()   // Currently checking
ext.isChecked()    // Check complete
ext.refresh()      // Function to re-check extension availability
```

## Relay Utilities

The SDK includes a standalone relay subpackage for managing Nostr relay connections, batching queries, and tracking relay performance. These utilities are pool-agnostic and work with any `PoolLike` implementation (e.g. `SimplePool` from nostr-tools).

```bash
npm install nostr-wot-sdk nostr-tools
```

### Basic Usage

```javascript
import { QueryBatcher, RelayPool, RelayStats } from 'nostr-wot-sdk/relay';
import { SimplePool } from 'nostr-tools';

// Optional: track relay performance
const stats = new RelayStats();
await stats.init(); // works in-memory, or pass a persistence adapter

// Create a relay pool
const pool = new RelayPool({
  urls: ['wss://relay.damus.io', 'wss://nos.lol'],
  prioritizeUrls: (urls) => stats.getPrioritizedUrls(urls),
  onStatusChange: (statuses) => console.log('Relay statuses:', statuses),
});

// Initialize with SimplePool
pool.ensurePool(() => new SimplePool());

// Query with automatic batching + progressive results
const events = await pool.query(
  { kinds: [1], limit: 50 },
  { onUpdate: (partial) => renderNotes(partial) }
);

// Subscribe to live events
const sub = pool.subscribe({ kinds: [1], since: Math.floor(Date.now() / 1000) }, {
  onEvent: (event) => console.log('New note:', event.content),
  onEose: () => console.log('Caught up'),
});

// Clean up
sub.close();
pool.destroy();
stats.destroy();
```

### QueryBatcher

Debounces and merges concurrent relay queries for efficiency. Queries made within the debounce window are batched together, compatible filters are merged, and results stream progressively.

```javascript
import { QueryBatcher } from 'nostr-wot-sdk/relay';
import { SimplePool } from 'nostr-tools';

const batcher = new QueryBatcher(new SimplePool(), {
  debounceMs: 100,       // batch window (default: 100)
  collectionWindowMs: 200, // wait after first event (default: 200)
  maxWaitMs: 5000,       // hard timeout (default: 5000)
});

// These concurrent queries get merged into fewer relay requests
const [profiles, contacts] = await Promise.all([
  batcher.query(['wss://relay.damus.io'], { kinds: [0], authors: pubkeys }),
  batcher.query(['wss://relay.damus.io'], { kinds: [3], authors: pubkeys }),
]);

// For user-initiated actions, bypass the debounce
const notes = await batcher.queryImmediate(urls, { kinds: [1], limit: 20 });

batcher.destroy();
```

### RelayStats

Tracks per-relay latency, success rate, and applies exponential backoff to failing relays.

```javascript
import { RelayStats } from 'nostr-wot-sdk/relay';

const stats = new RelayStats({ maxBackoffMs: 30000 });

// Optional: load persisted stats (e.g. from IndexedDB)
await stats.init({
  load: async () => db.getAll('relayStats'),
  save: async (data) => db.putAll('relayStats', data),
});

// Record relay performance
stats.recordSuccess('wss://relay.damus.io', 150); // 150ms latency
stats.recordFailure('wss://slow.relay.com', 'timeout');

// Get URLs sorted by reliability + speed
const prioritized = stats.getPrioritizedUrls([
  'wss://relay.damus.io',
  'wss://slow.relay.com',
  'wss://nos.lol',
]);

// Check backoff status
stats.isBackedOff('wss://slow.relay.com'); // true

stats.destroy();
```

### RelayPool

Manages pool lifecycle, subscriptions, publishing, and NIP-65 relay list fetching.

```javascript
import { RelayPool } from 'nostr-wot-sdk/relay';
import { SimplePool } from 'nostr-tools';

const pool = new RelayPool({
  urls: ['wss://relay.damus.io', 'wss://nos.lol'],
  authorChunkSize: 150, // chunk large author lists
  onRelaysChanged: (urls) => saveToSettings(urls),
});

pool.ensurePool(() => new SimplePool());

// Subscribe to notes from followed authors (auto-chunks large lists)
const sub = pool.subscribeAuthors(followedPubkeys, { kinds: [1], since, limit: 200 },
  (event) => addToFeed(event),
  () => console.log('Caught up')
);

// Publish events
await pool.publish(signedEvent);

// Fetch a user's NIP-65 relay list
const userRelays = await pool.fetchUserRelays(pubkey);

// Manage relays
pool.addRelay('wss://new.relay.com');
pool.removeRelay('wss://old.relay.com');

pool.destroy();
```

### React Integration

```javascript
import { RelayProvider, useRelayPool, useRelayStatuses } from 'nostr-wot-sdk/relay/react';
import { SimplePool } from 'nostr-tools';

function App() {
  return (
    <RelayProvider
      urls={['wss://relay.damus.io', 'wss://nos.lol']}
      createPool={() => new SimplePool()}
      enableStats={true}
    >
      <Feed />
    </RelayProvider>
  );
}

function Feed() {
  const pool = useRelayPool();
  const { statuses, connectedCount } = useRelayStatuses();

  useEffect(() => {
    pool.query({ kinds: [1], limit: 30 }).then(setNotes);
  }, [pool]);

  return (
    <div>
      <span>{connectedCount} relays connected</span>
      {/* render notes */}
    </div>
  );
}
```

#### Provider Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `urls` | `string[]` | required | Relay WebSocket URLs |
| `createPool` | `() => PoolLike` | required | Factory to create pool instance |
| `poolOptions` | `Partial<RelayPoolOptions>` | — | Options for RelayPool |
| `batcherOptions` | `QueryBatcherOptions` | — | Options for QueryBatcher |
| `statsPersistence` | `RelayStatsPersistence` | — | Persistence adapter for stats |
| `statsOptions` | `RelayStatsOptions` | — | Options for RelayStats |
| `enableStats` | `boolean` | `true` | Enable relay performance tracking |

#### Available Hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `useRelayPool()` | `RelayPool` | Access the RelayPool instance |
| `useQueryBatcher()` | `QueryBatcher` | Access the QueryBatcher instance |
| `useRelayStats()` | `RelayStats \| null` | Access RelayStats (null if disabled) |
| `useRelayStatuses()` | `{ statuses, connectedCount }` | Reactive connection statuses |
| `useRelayContext()` | `RelayContextValue` | Full context with all instances |

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
