/**
 * IndexedDB storage for the local WoT graph.
 *
 * Ported from the extension (`lib/storage.ts`), generalized from per-account
 * databases to a `namespace` key and wrapped in a class so multiple graphs can
 * coexist. Preserves the two performance-critical techniques:
 *
 * - **Interning**: pubkeys (64-hex) are mapped to small integer ids, so the
 *   graph is stored/traversed as numbers instead of strings.
 * - **Delta encoding**: each node's sorted follow-id list is stored as a
 *   `Uint32Array` of deltas, which compresses well and keeps memory bounded for
 *   the 100k+ nodes a 2-hop crawl can yield.
 *
 * When `indexedDB` is unavailable (Node without a polyfill) the store operates
 * in memory-only mode: crawl/query still work, nothing is persisted.
 */

import type { GraphMeta, StorageStats } from './types';

const DB_PREFIX = 'nostr-wot-graph';
const DB_VERSION = 1;
const STORE_PUBKEYS = 'pubkeys';
const STORE_FOLLOWS = 'follows';
const STORE_META = 'meta';

// Encode follow ids for storage (sort + delta encode into a Uint32Array).
export function encodeFollows(followIds: ArrayLike<number>): ArrayBuffer {
  if (followIds.length === 0) return new ArrayBuffer(0);

  const sorted = Array.from(followIds).sort((a, b) => a - b);

  const deltas = new Uint32Array(sorted.length);
  deltas[0] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    deltas[i] = sorted[i] - sorted[i - 1];
  }

  return deltas.buffer;
}

// Decode follow ids from storage (delta decode back to absolute values).
export function decodeFollows(buffer: ArrayBuffer | null | undefined): Uint32Array {
  if (!buffer || buffer.byteLength === 0) return new Uint32Array(0);

  const deltas = new Uint32Array(buffer);
  const result = new Uint32Array(deltas.length);

  result[0] = deltas[0];
  for (let i = 1; i < deltas.length; i++) {
    result[i] = result[i - 1] + deltas[i];
  }

  return result;
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export class GraphStorage {
  readonly namespace: string;
  private db: IDBDatabase | null = null;
  private memoryOnly = false;
  private opened = false;

  // In-memory caches (source of truth for reads/BFS).
  private pubkeyToId = new Map<string, number>();
  private idToPubkey = new Map<number, string>();
  private nextId = 1;
  private graphCache = new Map<number, Uint32Array>();
  private metaCache = new Map<string, unknown>();

  // Pending persistence buffers (drained by flush()).
  private dirtyFollows = new Map<number, number[]>();
  private dirtyPubkeys: Array<{ id: number; pubkey: string }> = [];

  constructor(namespace: string) {
    if (!namespace) throw new Error('GraphStorage requires a namespace');
    this.namespace = namespace;
  }

  private dbName(): string {
    return `${DB_PREFIX}:${this.namespace}`;
  }

  /** Open (or create) the namespace DB and hydrate in-memory caches. */
  async open(): Promise<void> {
    if (this.opened) return;

    if (!hasIndexedDB()) {
      this.memoryOnly = true;
      this.opened = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.dbName(), DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;
        if (!database.objectStoreNames.contains(STORE_PUBKEYS)) {
          const store = database.createObjectStore(STORE_PUBKEYS, { keyPath: 'id' });
          store.createIndex('pubkey', 'pubkey', { unique: true });
        }
        if (!database.objectStoreNames.contains(STORE_FOLLOWS)) {
          database.createObjectStore(STORE_FOLLOWS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_META)) {
          database.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });

    this.opened = true;
    await this.loadAll();
  }

  /** Hydrate the in-memory interning + follow maps + meta from the DB. */
  async loadAll(): Promise<void> {
    this.pubkeyToId.clear();
    this.idToPubkey.clear();
    this.graphCache.clear();
    this.metaCache.clear();
    this.nextId = 1;

    if (this.memoryOnly || !this.db) return;
    const db = this.db;

    const pubkeys = await this.getAll<{ id: number; pubkey: string }>(db, STORE_PUBKEYS);
    for (const record of pubkeys) {
      this.pubkeyToId.set(record.pubkey, record.id);
      this.idToPubkey.set(record.id, record.pubkey);
      if (record.id >= this.nextId) this.nextId = record.id + 1;
    }

    const follows = await this.getAll<{ id: number; follows: ArrayBuffer }>(db, STORE_FOLLOWS);
    for (const record of follows) {
      this.graphCache.set(record.id, decodeFollows(record.follows));
    }

    const meta = await this.getAll<{ key: string; value: unknown }>(db, STORE_META);
    for (const record of meta) {
      this.metaCache.set(record.key, record.value);
    }
  }

  private getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  // ── Interning ──

  /** Numeric id for a pubkey, or null if never seen. */
  getId(pubkey: string): number | null {
    return this.pubkeyToId.get(pubkey) ?? null;
  }

  /** Numeric id for a pubkey, minting and buffering a new one if needed. */
  getOrCreateId(pubkey: string): number {
    const existing = this.pubkeyToId.get(pubkey);
    if (existing !== undefined) return existing;

    const id = this.nextId++;
    this.pubkeyToId.set(pubkey, id);
    this.idToPubkey.set(id, pubkey);
    this.dirtyPubkeys.push({ id, pubkey });
    return id;
  }

  /** Batch variant of {@link getOrCreateId}. */
  getOrCreateIds(pubkeys: string[]): number[] {
    const ids = new Array<number>(pubkeys.length);
    for (let i = 0; i < pubkeys.length; i++) {
      ids[i] = this.getOrCreateId(pubkeys[i]);
    }
    return ids;
  }

  /** Pubkey for a numeric id, or null. */
  getHex(id: number): string | null {
    return this.idToPubkey.get(id) ?? null;
  }

  /** Highest assigned id (for typed-array sizing). */
  getMaxId(): number {
    return this.nextId - 1;
  }

  // ── Follows ──

  /** Store `pubkey`'s follow list. Interns everything and updates the cache. */
  saveFollows(pubkey: string, follows: string[]): void {
    const id = this.getOrCreateId(pubkey);
    const followIds = this.getOrCreateIds(follows);
    this.graphCache.set(id, new Uint32Array(followIds));
    this.dirtyFollows.set(id, followIds);
  }

  /** Follow ids for a node id — sync, from the in-memory cache. */
  getFollowIdsSync(id: number): Uint32Array {
    return this.graphCache.get(id) ?? new Uint32Array(0);
  }

  /** Follow ids for a pubkey (interned). Empty if unknown. */
  getFollowIds(pubkey: string): Uint32Array {
    const id = this.getId(pubkey);
    if (id === null) return new Uint32Array(0);
    return this.getFollowIdsSync(id);
  }

  /** Follow list of `pubkey` as hex strings. */
  getFollows(pubkey: string): string[] {
    const ids = this.getFollowIds(pubkey);
    const out: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const hex = this.getHex(ids[i]);
      if (hex) out.push(hex);
    }
    return out;
  }

  // ── Meta ──

  async setMeta(key: string, value: unknown): Promise<void> {
    this.metaCache.set(key, value);
    if (this.memoryOnly || !this.db) return;
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  getMeta<T = unknown>(key: string): T | undefined {
    return this.metaCache.get(key) as T | undefined;
  }

  /** Read the structured graph meta record. */
  getGraphMeta(): GraphMeta {
    return {
      root: (this.getMeta<string>('root') ?? null) as string | null,
      lastCrawl: (this.getMeta<number>('lastCrawl') ?? null) as number | null,
      maxDepth: (this.getMeta<number>('maxDepth') ?? null) as number | null,
      version: this.getMeta<number>('version') ?? DB_VERSION,
    };
  }

  // ── Persistence ──

  /** Flush buffered pubkey + follow writes to IndexedDB. No-op in memory mode. */
  async flush(): Promise<void> {
    if (this.memoryOnly || !this.db) {
      this.dirtyPubkeys.length = 0;
      this.dirtyFollows.clear();
      return;
    }
    const db = this.db;

    const pubkeys = this.dirtyPubkeys.splice(0, this.dirtyPubkeys.length);
    const follows = Array.from(this.dirtyFollows.entries());
    this.dirtyFollows.clear();

    if (pubkeys.length === 0 && follows.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const stores: string[] = [];
      if (pubkeys.length) stores.push(STORE_PUBKEYS);
      if (follows.length) stores.push(STORE_FOLLOWS);
      const tx = db.transaction(stores, 'readwrite');

      if (pubkeys.length) {
        const store = tx.objectStore(STORE_PUBKEYS);
        for (const row of pubkeys) store.put(row);
      }
      if (follows.length) {
        const store = tx.objectStore(STORE_FOLLOWS);
        for (const [id, followIds] of follows) {
          store.put({ id, follows: encodeFollows(followIds), updated_at: Date.now() });
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Stats / clear ──

  stats(): StorageStats {
    let edges = 0;
    for (const follows of this.graphCache.values()) edges += follows.length;
    return {
      nodes: this.graphCache.size,
      edges,
      uniquePubkeys: this.pubkeyToId.size,
    };
  }

  /** Wipe this namespace: memory caches + persisted stores. */
  async clear(): Promise<void> {
    this.pubkeyToId.clear();
    this.idToPubkey.clear();
    this.graphCache.clear();
    this.metaCache.clear();
    this.dirtyFollows.clear();
    this.dirtyPubkeys.length = 0;
    this.nextId = 1;

    if (this.memoryOnly || !this.db) return;
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FOLLOWS, STORE_PUBKEYS, STORE_META], 'readwrite');
      tx.objectStore(STORE_FOLLOWS).clear();
      tx.objectStore(STORE_PUBKEYS).clear();
      tx.objectStore(STORE_META).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Close the underlying DB connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.opened = false;
  }
}
