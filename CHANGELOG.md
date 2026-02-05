# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2025-02-05

### Breaking Changes

- **Removed `useExtension` option** - The SDK now always uses the extension when available
  - Extension-first is now the only mode; no need to opt-in
  - `WoTOptions.useExtension` has been removed from the type
  - Simply create `new WoT()` or `new WoT({ fallback: { myPubkey: '...' } })`

- **Removed local sync functionality** - Use the browser extension for local graph storage
  - Removed `src/local/` directory entirely
  - Removed `nostr-wot-sdk/local` export
  - Extension handles all syncing and local storage

- **Trust scores now come from extension only**
  - Removed SDK-side trust score calculation
  - `getTrustScore(target)` no longer accepts options parameter
  - Returns 0 when extension is not available

### Changed

- `WoT` constructor now has all parameters optional
- `WoTProvider` no longer has `useExtension` option
- Simplified codebase with extension-first architecture

## [0.3.2] - 2025-02-05

### Changed

- **Scoring formula changed from multiplicative to additive** to match extension
  - Old: `score = baseScore × distanceWeight × (1 + bonuses)`
  - New: `score = (baseScore × distanceWeight) + bonuses`
  - Example: 2 hops + 30% path bonus = 0.5 + 0.3 = 0.80 (was 0.65)
  - This produces higher scores for pubkeys with multiple paths

## [0.3.1] - 2025-02-05

### Added

- `getDistanceBatch(targets, includePaths?)` now accepts an optional `includePaths` parameter
  - When `false` (default): returns `{ pubkey: hops }` - backwards compatible
  - When `true`: returns `{ pubkey: { hops, paths } }` - includes path count for scoring

### Changed

- `getTrustScoreBatch` now uses path counts internally for accurate trust score calculation with path bonuses

## [0.3.0] - 2025-02-05

### Added

- **Automatic Extension Connection for React** - Zero-config React integration
  - `WoTProvider` now auto-connects to the extension by default (`useExtension: true`)
  - New `useExtension()` hook for accessing extension connection state
  - Extension state includes: `isConnected`, `isConnecting`, `isInstalled`, `isChecked`, `error`, `connect()`

- **Event-based Extension Connection Flow**
  - New `src/extension.ts` module with reliable extension detection
  - `checkExtension(timeout?)` - Check if extension is installed using `nostr-wot-check` → `nostr-wot-present` handshake
  - `connectExtension(timeout?)` - Connect to extension using `nostr-wot-connect` → `nostr-wot-ready` handshake
  - `checkAndConnect(options?)` - Combined check and connect in one call
  - `ExtensionConnector` class - Stateful connector with subscription support for state changes
  - `getDefaultConnector()` / `resetDefaultConnector()` - Singleton pattern for shared connector

- **New Extension Events Protocol**
  | Event | Direction | Purpose |
  |-------|-----------|---------|
  | `nostr-wot-check` | Page → Extension | Check if extension installed |
  | `nostr-wot-present` | Extension → Page | Response confirming presence |
  | `nostr-wot-connect` | Page → Extension | Request API injection |
  | `nostr-wot-ready` | Extension → Page | API is ready at `window.nostr.wot` |
  | `nostr-wot-error` | Extension → Page | Injection failed with error |

### Changed

- `WoTProvider` props are now optional - just `<WoTProvider>` works out of the box
- `WoT` class `getExtension()` now uses event-based connection flow for reliable detection

### Usage

```tsx
import { WoTProvider, useWoT, useExtension } from 'nostr-wot-sdk/react';

// Just wrap your app - no config needed
function App() {
  return (
    <WoTProvider>
      <YourApp />
    </WoTProvider>
  );
}

// Check extension status
function Status() {
  const { isConnected, isConnecting } = useExtension();
  if (isConnecting) return <span>Connecting...</span>;
  return <span>{isConnected ? 'Connected' : 'Not connected'}</span>;
}

// Use WoT data
function Profile({ pubkey }) {
  const { distance, score, loading } = useWoT(pubkey);
  // ...
}
```

## [0.2.0] - 2025-02-04

### Added

- Full extension API support matching [nostr-wot-extension](https://github.com/nostr-wot/nostr-wot-extension)
- Extension-first architecture: extension always takes priority when available
- New extension-only methods:
  - `getFollows(pubkey?)` - Get follow list
  - `getCommonFollows(pubkey)` - Get mutual follows
  - `getPath(target)` - Get actual path to target
  - `getStats()` - Get graph statistics
  - `isConfigured()` - Check extension configuration status
  - `getExtensionConfig()` - Get extension configuration
- Batch operations:
  - `getDistanceBatch(targets)` - Batch distance queries
  - `getTrustScoreBatch(targets)` - Batch trust score queries
  - `filterByWoT(pubkeys, options?)` - Filter pubkeys by WoT membership
- React integration (`nostr-wot-sdk/react`):
  - `WoTProvider` - Context provider
  - `useWoT(pubkey)` - Full WoT data hook
  - `useIsInWoT(pubkey)` - Boolean WoT check
  - `useTrustScore(pubkey)` - Trust score hook
  - `useBatchWoT(pubkeys)` - Batch queries hook
- Local mode (`nostr-wot-sdk/local`) for server-side usage
- GitHub Actions workflows for CI and npm publishing

### Changed

- `WoTOptions.useExtension` controls extension usage (default: `false`)
- Fallback configuration via `WoTOptions.fallback` for oracle mode when extension unavailable

## [0.1.0] - 2025-02-03

### Added

- Initial release
- Core `WoT` class with oracle-based queries
- Methods: `getDistance`, `isInMyWoT`, `getTrustScore`, `getDistanceBetween`, `batchCheck`, `getDetails`
- Custom scoring configuration
- TypeScript support with full type definitions
- Error classes: `WoTError`, `NetworkError`, `NotFoundError`, `TimeoutError`, `ValidationError`

[0.4.0]: https://github.com/nostr-wot/nostr-wot-sdk/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/nostr-wot/nostr-wot-sdk/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nostr-wot/nostr-wot-sdk/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nostr-wot/nostr-wot-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nostr-wot/nostr-wot-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nostr-wot/nostr-wot-sdk/releases/tag/v0.1.0
