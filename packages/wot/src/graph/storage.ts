/**
 * IndexedDB storage for the local WoT graph.
 *
 * Ported from the extension (`lib/storage.ts`), generalized from per-account
 * databases to a `namespace` key and wrapped in a class so multiple graphs can
 * coexist. Preserves the two performance-critical techniques:
 *
 * - **Interning**: pubkeys (64-hex) are mapped to small integer ids, so the
 *   graph is stored/traversed as numbers instead of strings.
 * - **Compact persistence**: sorted follow ids are delta-varint encoded on disk;
 *   hydrated adjacency remains Uint32Array for numeric traversal. Legacy fixed-
 *   width delta rows remain readable.
 *
 * When `indexedDB` is unavailable (Node without a polyfill) the store operates
 * in memory-only mode: crawl/query still work, nothing is persisted.
 */

import type { GraphMeta, StorageStats } from './types';

const DB_PREFIX = 'nostr-wot-graph';
const DB_VERSION = 2;
const STORE_PUBKEYS = 'pubkeys';
const STORE_FOLLOWS = 'follows';
const STORE_META = 'meta';
const EMPTY_IDS = new Uint32Array(0);
export interface FollowVersion { createdAt: number; id: string }
export function newerVersion(candidate: FollowVersion, prior: FollowVersion): boolean {
  return candidate.createdAt > prior.createdAt || candidate.createdAt === prior.createdAt && candidate.id < prior.id;
}

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

// Versioned disk rows use unsigned delta varints; the exported fixed-width
// helpers remain compatible with existing callers and legacy database rows.
export function encodeCompactFollows(ids: ArrayLike<number>): ArrayBuffer {
  const sorted = Array.from(new Set(Array.from(ids))).sort((a, b) => a - b);
  const bytes: number[] = [];
  let prior = 0;
  for (const id of sorted) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
      throw new RangeError("Follow IDs must be unsigned 32-bit integers");
    }
    let delta = id - prior;
    prior = id;
    while (delta >= 128) { bytes.push((delta % 128) | 128); delta = Math.floor(delta / 128); }
    bytes.push(delta);
  }
  return Uint8Array.from(bytes).buffer;
}

export function decodeCompactFollows(buffer: ArrayBuffer): Uint32Array {
  const values: number[] = [];
  let prior = 0, delta = 0, factor = 1;
  for (const byte of new Uint8Array(buffer)) {
    delta += (byte & 127) * factor;
    if (delta > 0xffffffff || factor > 0x10000000) throw new Error('Invalid follow varint');
    if (byte & 128) factor *= 128;
    else {
      prior += delta;
      if (prior > 0xffffffff) throw new Error('Follow id overflow');
      values.push(prior); delta = 0; factor = 1;
    }
  }
  if (factor !== 1) throw new Error('Truncated follow varint');
  return Uint32Array.from(values);
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export class GraphStorage {
  readonly namespace: string;
  private db: IDBDatabase | null = null;
  private memoryOnly = false;
  private opened = false;
  private opening: Promise<void> | null = null;
  private revision = 0;
  private edges = 0;
  private versions = new Map<number, FollowVersion>();
  private flushing: Promise<void> = Promise.resolve();

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
    if (this.opening) return this.opening;
    if (this.opened) return;
    this.opening = this.openDatabase();
    try { await this.opening; } finally { this.opening = null; }
  }

  private async openDatabase(): Promise<void> {

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

    await this.loadAll();
    this.opened = true;
  }

  /** Hydrate the in-memory interning + follow maps + meta from the DB. */
  async loadAll(): Promise<void> {
    this.pubkeyToId.clear();
    this.idToPubkey.clear();
    this.graphCache.clear();
    this.metaCache.clear();
    this.nextId = 1;
    this.versions.clear();
    this.edges = 0;
    this.revision++;

    if (this.memoryOnly || !this.db) return;
    const db = this.db;

    const tx = db.transaction([STORE_PUBKEYS, STORE_FOLLOWS, STORE_META], 'readonly');
    const [pubkeys, follows, meta] = await Promise.all([
      this.getAll<{ id: number; pubkey: string }>(tx, STORE_PUBKEYS),
      this.getAll<{ id: number; follows: ArrayBuffer; encoding?: string; version?: FollowVersion }>(tx, STORE_FOLLOWS),
      this.getAll<{ key: string; value: unknown }>(tx, STORE_META),
    ]);
    for (const record of pubkeys) {
      this.pubkeyToId.set(record.pubkey, record.id);
      this.idToPubkey.set(record.id, record.pubkey);
      if (record.id >= this.nextId) this.nextId = record.id + 1;
    }

    for (const record of follows) {
      if (record.encoding && record.encoding !== 'delta-varint-v1') throw new Error('Unknown follow encoding');
      const row = record.encoding === 'delta-varint-v1' ? decodeCompactFollows(record.follows) : Uint32Array.from(new Set(decodeFollows(record.follows)));
      this.graphCache.set(record.id, row);
      this.edges += row.length;
      if (record.version) this.versions.set(record.id, record.version);
    }

    for (const record of meta) {
      this.metaCache.set(record.key, record.value);
    }
  }

  private getAll<T>(tx: IDBTransaction, store: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
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
  saveFollows(pubkey: string, follows: string[], version?: FollowVersion): boolean {
    const id = this.getOrCreateId(pubkey);
    const priorVersion = this.versions.get(id);
    if (version && priorVersion && !newerVersion(version, priorVersion)) return false;
    const followIds = this.getOrCreateIds([...new Set(follows)]).sort((a, b) => a - b);
    const prior = this.graphCache.get(id);
    const changed = !prior || prior.length !== followIds.length || followIds.some((v, i) => prior[i] !== v);
    if (version) this.versions.set(id, { ...version });
    else this.versions.delete(id);
    if (changed) {
      this.edges += followIds.length - (prior?.length ?? 0);
      this.graphCache.set(id, new Uint32Array(followIds));
      this.revision++;
    }
    if (changed || version || priorVersion) this.dirtyFollows.set(id, followIds);
    return true;
  }

  getRevision(): number { return this.revision; }
  getFollowVersion(pubkey: string): FollowVersion | undefined {
    const id = this.getId(pubkey);
    const version = id === null ? undefined : this.versions.get(id);
    return version ? { ...version } : undefined;
  }

  /** Follow ids for a node id — sync, from the in-memory cache. */
  getFollowIdsSync(id: number): Uint32Array {
    return this.graphCache.get(id) ?? EMPTY_IDS;
  }

  /** Follow ids for a pubkey (interned). Empty if unknown. */
  getFollowIds(pubkey: string): Uint32Array {
    const id = this.getId(pubkey);
    if (id === null) return EMPTY_IDS;
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
    await this.setMetaBatch({ [key]: value });
  }

  async setMetaBatch(values: Record<string, unknown>): Promise<void> {
    if (this.memoryOnly || !this.db) {
      for (const [key, value] of Object.entries(values)) this.metaCache.set(key, value);
      return;
    }
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      for (const [key, value] of Object.entries(values)) tx.objectStore(STORE_META).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Graph transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Metadata write aborted"));
    });
    for (const [key, value] of Object.entries(values)) this.metaCache.set(key, value);
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
  flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushPending());
    this.flushing = run.catch(() => {});
    return run;
  }

  private async flushPending(): Promise<void> {
    if (this.memoryOnly || !this.db) {
      this.dirtyPubkeys.length = 0;
      this.dirtyFollows.clear();
      return;
    }
    const db = this.db;

    const pubkeys = this.dirtyPubkeys.slice();
    const follows = Array.from(this.dirtyFollows.entries());
    const versions = new Map(follows.map(([id]) => [id, this.versions.get(id)]));

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
          store.put({ id, follows: encodeCompactFollows(followIds), encoding: 'delta-varint-v1', updated_at: Date.now(), version: versions.get(id) });
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Graph transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Graph flush aborted"));
    });
    this.dirtyPubkeys.splice(0, pubkeys.length);
    for (const [id, row] of follows) {
      if (this.dirtyFollows.get(id) === row) this.dirtyFollows.delete(id);
    }
  }

  // ── Stats / clear ──

  stats(): StorageStats {
    return {
      nodes: this.graphCache.size,
      edges: this.edges,
      uniquePubkeys: this.pubkeyToId.size,
    };
  }

  /** Wipe this namespace: memory caches + persisted stores. */
  async clear(): Promise<void> {
    await this.flushing;
    if (!this.memoryOnly && this.db) {
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FOLLOWS, STORE_PUBKEYS, STORE_META], 'readwrite');
      tx.objectStore(STORE_FOLLOWS).clear();
      tx.objectStore(STORE_PUBKEYS).clear();
      tx.objectStore(STORE_META).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Graph transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Graph clear aborted"));
    });
    }
    this.pubkeyToId.clear();
    this.idToPubkey.clear();
    this.graphCache.clear();
    this.metaCache.clear();
    this.dirtyFollows.clear();
    this.dirtyPubkeys.length = 0;
    this.nextId = 1;
    this.versions.clear();
    this.edges = 0;
    this.revision++;

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
