# @nostr-wot/dm

Direct messages for Nostr — encryption primitives, a streaming inbox cache, and React hooks. One package, three layers, pick what you need.

| Entry | What's in it | Depends on |
|---|---|---|
| `@nostr-wot/dm` | Crypto primitives: NIP-04 encrypt/decrypt, NIP-17 seal + gift-wrap | `nostr-tools`, `@nostr-wot/signers` |
| `@nostr-wot/dm/cache` | Per-session inbox: live subscription, auto-decrypt, send, backfill, read cursors, encrypted-at-rest storage | + `@nostr-wot/data` |
| `@nostr-wot/dm/react` | Hooks: `useDMSession`, `useThread`, `useConversations`, `useUnreadCount`, … | + `react` (peer) |

## Install

```bash
npm i @nostr-wot/dm @nostr-wot/signers nostr-tools
# add @nostr-wot/data + react if using /cache or /react
```

---

## Layering

Three packages, three jobs: `@nostr-wot/pq` holds the post-quantum primitives (ML-KEM-1024 +
NIP-44 hybrid envelope), `@nostr-wot/signers` owns key material and is therefore the layer that
performs post-quantum sealing, and `@nostr-wot/dm` (this package) only does transport — it
builds the gift wrap and hands the plaintext to the signer, never touching a key. To send a
post-quantum DM, pass the recipient's ML-KEM key through `sealAndGiftWrap`'s `pq` option; the
signer does the rest, and `unwrapGiftWrap` needs no matching option because `nip44Decrypt`
auto-routes on the self-describing envelope.

```ts
import { buildChatMessage, sealAndGiftWrap } from "@nostr-wot/dm";

const inner = buildChatMessage(me, recipientPubkey, "hello, post-quantum");
const giftWrap = await sealAndGiftWrap(signer, recipientPubkey, inner, {
  pq: { scheme: "pq", recipientKemKey }, // from the recipient's kind:10203 attestation
});
```

---

## Layer 1 — Crypto primitives

`@nostr-wot/dm` (the root entry) exposes pure, signer-driven encryption/decryption. No subscriptions, no cache.

### NIP-17 sealed messages (recommended)

Built on NIP-44 v2 + gift wrapping. Hides sender; recipient is visible only via the wrap's `p` tag. Seal + wrap timestamps are randomized within ±2 days of `now` so traffic-analysis can't correlate.

```ts
import { buildChatMessage, sealAndGiftWrap, unwrapGiftWrap } from "@nostr-wot/dm";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const me = await signer.getPublicKey();

// Send
const inner = buildChatMessage(me, recipientPubkey, "hello");
const giftWrap = await sealAndGiftWrap(signer, recipientPubkey, inner);
// publish giftWrap (kind 1059) to recipient's read relays

// Receive
const { message, senderPubkey } = await unwrapGiftWrap(signer, giftWrap);
// message.content is the plaintext, senderPubkey recovered from the seal
```

### NIP-04 (legacy)

Kind-4 AES-CBC. Sender + recipient visible on the wire. Still widely deployed; use as fallback only.

```ts
import { encryptNip04, decryptNip04 } from "@nostr-wot/dm";

const event = await encryptNip04(signer, recipientPubkey, "hello");
const plaintext = await decryptNip04(signer, event);
```

---

## Layer 2 — Cache (`/cache`)

A complete inbox subsystem: subscribes to inbound events, auto-decrypts via your signer, dedupes, ingests into in-memory observables, and (optionally) persists to a `DMStorage` backend. Built on `@nostr-wot/data`'s `sharedCoalescer`, so DM subscriptions piggyback on the same connection pool used by profile/note fetchers.

### Bootstrap a session

```ts
import {
  initDMSession,
  subscribeInbox,
  sendDM,
  localStorageDMStorage,
} from "@nostr-wot/dm/cache";

const session = await initDMSession({
  myPubkey,
  signer,
  relays: ["wss://relay.damus.io", "wss://nos.lol"],
  storage: localStorageDMStorage(),  // optional persistence
  discoverInboxRelays: true,         // auto-resolve kind 10050
});

const stop = subscribeInbox(session); // live; returns teardown

await sendDM(session, partnerPubkey, "hi", { scheme: "nip17" }); // default
```

`subscribeInbox` opens three coalesced subscriptions: NIP-04 inbound (`#p == me`), NIP-04 outbound echo (`authors == me`), and NIP-17 gift wraps (`#p == me`). Every event is decrypted and ingested through the same `ingestMessage` pipeline — UI subscribers see one consistent stream.

### Inbox-relay discovery + publishing (kind 10050)

```ts
import { fetchInboxRelays, publishInboxRelays } from "@nostr-wot/dm/cache";

// Where do my DMs go?
const inbox = await fetchInboxRelays(myPubkey, defaultRelays);

// Tell other clients where to send my DMs
await publishInboxRelays(signer, /* publish to */ relays, /* inbox = */ inbox);
```

Without a kind-10050, your NIP-17 DMs only arrive from senders who happen to share a relay with you.

### Historical backfill

`subscribeInbox` only catches new events. To populate threads on first login (or after a long offline period), walk past kind-1059 wraps:

```ts
import { backfillInbox } from "@nostr-wot/dm/cache";

const { partners, ingested, windowsWalked } = await backfillInbox(session, {
  windows: 12,         // 12 × 30-day = ≈1 year
  limit: 200,          // events per window per filter
  minPartners: 50,     // stop once enough partners discovered
  timeoutMs: 30_000,   // hard wallclock budget
});
```

### Read cursors (device-local)

Read state is intentionally **never** synced to relays — no server should know who you're DMing. Read cursors live in `localStorage`, keyed per account.

```ts
import {
  markRead,
  setReadCursor,
  getReadCursor,
  getUnreadCount,
  getUnreadCounts,
  detectScheme,
} from "@nostr-wot/dm/cache";

markRead(myPubkey, partnerPubkey);
const unread = getUnreadCount(myPubkey, partnerPubkey);
const allUnreads = getUnreadCounts(myPubkey);  // { partnerHex: n, ... }

// Predict whether to send NIP-04 or NIP-17 to a partner based on
// the most recent cached messages.
const scheme = detectScheme(messages); // "nip04" | "nip17" | null
```

### Encrypted-at-rest storage

Wrap any `DMStorage` with AES-GCM encryption keyed by a NIP-44-self-encrypted KEK. The raw key is imported as a non-extractable WebCrypto key — XSS can call your encrypt/decrypt helpers but cannot exfiltrate the bytes.

```ts
import {
  initDMSession,
  localStorageDMStorage,
  getOrCreateCacheKey,
  wrapStorageWithEncryption,
} from "@nostr-wot/dm/cache";

const key = await getOrCreateCacheKey(myPubkey, signer);  // one-time signer prompt
const storage = wrapStorageWithEncryption(localStorageDMStorage()!, key);

await initDMSession({ myPubkey, signer, relays, storage });
```

### Custom storage backends

```ts
import type { DMStorage } from "@nostr-wot/dm/cache";

const indexedDBStorage: DMStorage = {
  async load(myPubkey) { /* ... */ },
  async save(myPubkey, conversations) { /* ... */ },
};
```

### Auto-persist + eviction

When you pass a `storage` to `initDMSession`, the session auto-persists on a debounce (default 500ms) after every cache mutation. Set `autoPersist: false` for manual control, or tune the debounce with `autoPersistDebounceMs`.

After each mutation the session also calls `evictIfNeeded(myPubkey, evictionCap)` (default cap 2000). Eviction is **a no-op until you register a follow set** — without one, every partner is treated as protected:

```ts
import { setFollowSet } from "@nostr-wot/dm/cache";
import { fetchFollows } from "@nostr-wot/data";

const follows = await fetchFollows(myPubkey);
setFollowSet(myPubkey, new Set(follows.pubkeys));   // enables eviction
// or pass null to explicitly mark "follows un-hydrated → protect everything"
setFollowSet(myPubkey, null);
```

Followed partners are never evicted; oldest non-followed messages drop first once the cap is exceeded.

### Logout / account switch

```ts
import { closeDMSession, clearDMSession } from "@nostr-wot/dm/cache";

closeDMSession(session);                               // stop subscriptions
await clearDMSession(myPubkey, { storage, clearStorage: true }); // wipe state
```

### Adapting an NDK signer

If you already have an NDK-based app, wrap your `NDKSigner` once and use the SDK end-to-end:

```ts
import { ndkSignerAsNostrSigner } from "@nostr-wot/signers";
import { NDKEvent } from "@nostr-dev-kit/ndk";

const signer = ndkSignerAsNostrSigner({
  ndk,
  NDKEvent,
});

await initDMSession({ myPubkey, signer, relays });
```

---

## Layer 3 — React (`/react`)

Hooks built on `useSyncExternalStore`. Concurrent-mode safe; no double-renders.

```tsx
import {
  useDMSession,
  useConversations,
  useThread,
  useUnreadCount,
  useUnreadCounts,
} from "@nostr-wot/dm/react";

function Inbox({ myPubkey, signer, relays }) {
  const { session, sendDM } = useDMSession({ signer, relays });
  const conversations = useConversations(myPubkey);
  const unreads = useUnreadCounts(myPubkey);

  return conversations.map((c) => (
    <Row
      key={c.partnerPubkey}
      preview={c.preview}
      lastAt={c.lastMessageAt}
      unread={unreads[c.partnerPubkey] ?? 0}
    />
  ));
}

function Thread({ myPubkey, partnerPubkey }) {
  const messages = useThread(myPubkey, partnerPubkey);
  const unread = useUnreadCount(myPubkey, partnerPubkey);
  return <ChatLog messages={messages} unread={unread} />;
}
```

`useDMSession` auto-subscribes to the inbox on mount and tears down on unmount. The returned `sendDM` is a stable callback bound to the session.

---

## API surface

### `@nostr-wot/dm`
| Export | Purpose |
|---|---|
| `KIND_NIP04_DM`, `KIND_NIP44_DM`, `KIND_SEALED`, `KIND_GIFT_WRAP` | Event-kind constants |
| `encryptNip04(signer, pk, plain)` | → kind-4 event |
| `decryptNip04(signer, event)` | → plaintext |
| `buildChatMessage(from, to, content, opts?)` | → kind-14 unsigned template |
| `sealAndGiftWrap(signer, recipient, message)` | → kind-1059 event |
| `unwrapGiftWrap(signer, giftWrap)` | → `{ message, senderPubkey }` |

### `@nostr-wot/dm/cache`
| Export | Purpose |
|---|---|
| `initDMSession({ myPubkey, signer, relays, storage?, discoverInboxRelays?, autoPersist?, autoPersistDebounceMs?, evictionCap? })` | Bootstrap + hydrate + auto-persist + eviction |
| `closeDMSession(session)` | Tear down subscriptions |
| `clearDMSession(myPubkey, { storage?, clearStorage? })` | Wipe per-account state |
| `subscribeInbox(session)` | Live decrypt loop; returns teardown |
| `sendDM(session, partner, content, { scheme? })` | Publish + local-echo |
| `persistDMSession(session)` | Manual snapshot to storage |
| `backfillInbox(session, opts?)` | Historical walker |
| `fetchInboxRelays(pubkey, fallback)` | Resolve kind 10050 |
| `publishInboxRelays(signer, publishRelays, inboxRelays)` | Publish kind 10050 |
| `relaysForPartner(partner, defaults)` | NIP-65 outbox merge |
| `setReadCursor`, `markRead`, `getReadCursor`, `getReadCursors` | Read-state |
| `getUnreadCount`, `getUnreadCounts`, `subscribeReadCursors` | Unread API |
| `detectScheme(messages)` | NIP-04 vs NIP-17 prediction |
| `setFollowSet`, `getFollowSet`, `subscribeFollowSet` | Follow set for eviction |
| `evictIfNeeded(myPubkey, cap?)` | Manual follow-aware LRU pass |
| `getOrCreateCacheKey(myPubkey, signer)` | KEK derivation |
| `encryptToCache(key, str)`, `decryptFromCache(key, blob)` | At-rest crypto |
| `wrapStorageWithEncryption(storage, key)` | At-rest `DMStorage` adapter |
| `localStorageDMStorage()` | Built-in plaintext storage |
| `KIND_NIP17_INBOX_RELAYS` (10050) | Constant |

### `@nostr-wot/dm/react`
| Export | Purpose |
|---|---|
| `useDMSession({ signer, relays, storage?, discoverInboxRelays? })` | Bootstrap + auto-subscribe |
| `useThread(myPubkey, partner)` | `DMMessage[]` |
| `useConversations(myPubkey)` | `DMConversation[]` |
| `useUnreadCount(myPubkey, partner)` | `number` |
| `useUnreadCounts(myPubkey)` | `Record<partner, number>` |
| `useReadCursors(myPubkey)` | `Record<partner, msTs>` |

---

## Types

```ts
type DMMessage = {
  id: string;
  fromPubkey: string;
  partnerPubkey: string;
  content: string;
  createdAt: number;       // unix seconds
  scheme: "nip04" | "nip17";
  raw?: NostrEvent;
};

type DMConversation = {
  partnerPubkey: string;
  lastMessageAt: number;
  preview: string;
  messageCount: number;
};

interface DMStorage {
  load(myPubkey: string): Promise<Record<string, DMMessage[]>>;
  save(myPubkey: string, conversations: Record<string, DMMessage[]>): Promise<void>;
}
```

---

## License

MIT
