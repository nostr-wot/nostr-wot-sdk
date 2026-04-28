# @nostr-wot/data

Pure-function Nostr data layer: profiles, notes, threads, follows, engagement (reactions / reposts / zaps), with NIP-65 outbox-model relay discovery baked in. Optional SWR cache layer and React hooks ship as separate entrypoints.

## Install

```bash
npm i @nostr-wot/data nostr-tools
```

## Three entrypoints

| Import path | Contains | Depends on |
|---|---|---|
| `@nostr-wot/data` | Pure fetchers, parsers, outbox helper, `getPool()` | `nostr-tools` (peer) |
| `@nostr-wot/data/cache` | SWR cache wrapping the fetchers; localStorage persistence | + the above |
| `@nostr-wot/data/react` | `useProfile`, `useNote`, `useThread`, … hooks | + react (peer) |

Use only what you need — the cache and React layers are optional.

## Vanilla fetchers (no cache, no React)

```ts
import { fetchProfile, fetchThread, fetchEngagement, relaysForAuthor } from '@nostr-wot/data';

// Outbox: gives you the union of defaults + the author's NIP-65 write relays
const relays = await relaysForAuthor('hex-pubkey');

const profile = await fetchProfile('hex-pubkey');
// → { displayName, name, picture, banner, about, nip05, lud16, fetchedAt }

const replies = await fetchThread('hex-event-id'); // kind-1 events with #e=this
const engagement = await fetchEngagement(['id1', 'id2']);
// → Map<id, { reactionCount, repostCount, zapTotalSats }>
```

## SWR cache layer

```ts
import { getProfile, getThread, fetchEngagementBatch, configurePersistence } from '@nostr-wot/data/cache';

configurePersistence({ namespace: 'myapp', ttlMs: 24 * 3600_000 });

const profile = await getProfile('hex-pubkey'); // cold-loads from localStorage,
                                                // refreshes in the background as
                                                // newer events arrive
```

## React hooks

```tsx
import { useProfile, useThread, useEngagement } from '@nostr-wot/data/react';

function ProfileCard({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey); // stale-while-revalidate
  if (!profile) return <Skeleton />;
  return <h1>{profile.displayName ?? profile.name}</h1>;
}
```

## Outbox model (NIP-65)

Every fetcher routes through the outbox helper by default — when you ask for an author's content, the SDK fetches their kind-10002 (NIP-65) relay list and queries the union of their declared write relays + your defaults. This is how you find content that doesn't make it to the popular relays.

To override defaults globally:

```ts
import { setDefaultRelays, setProfileAggregators } from '@nostr-wot/data';

setDefaultRelays(['wss://relay.damus.io', 'wss://nos.lol']);
setProfileAggregators(['wss://purplepag.es']);
```

Or per-call:

```ts
await fetchProfile(pubkey, ['wss://my-private-relay']);
```

## License

MIT
