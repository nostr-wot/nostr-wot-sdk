import type { NostrEvent } from "nostr-wot-sdk/relay";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { NostrConnect } from "nostr-tools/kinds";
import { normalizeRelays } from "./uri";
import type { BunkerLogger } from "./types";

export interface BunkerRelayManagerOptions {
  /** Installed process-wide, as with BunkerServer's standalone option. */
  websocketImplementation?: unknown;
  /** Default 3000 ms. Failed handshakes are explicitly closed before retry. */
  connectTimeoutMs?: number;
  /** Default 3000 ms, doubling up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  /** Default 60000 ms. */
  maxReconnectDelayMs?: number;
  /** Maximum unique normalized relay URLs across every owner, including publishes. Default 32. */
  maxRelays?: number;
  logger?: BunkerLogger;
}

export interface BunkerRelaySubscription {
  /** Settles after EOSE or the first failed attempt. Later failures retry centrally. */
  ready: Promise<void>;
  close(): void;
}

type Relay = Awaited<ReturnType<SimplePool["ensureRelay"]>>;
/**
 * Retain the in-flight relay independently of the pool's map. nostr-tools'
 * AbstractSimplePool.ensureRelay drops that entry on handshake failure, while
 * AbstractRelay.connect's timeout detaches socket handlers without closing it.
 * Its public close() still reaches that socket, so explicitly close the retained
 * relay before returning failure to the manager's central reconnect scheduler.
 */
class OwnedBunkerPool extends SimplePool {
  override async ensureRelay(url: string, params?: Parameters<SimplePool["ensureRelay"]>[1]): Promise<Relay> {
    const attempt = super.ensureRelay(url, params);
    const relay = this.relays.get(normalizeRelays([url])[0]!);
    try {
      return await attempt;
    } catch (err) {
      relay?.close();
      throw err;
    }
  }
}

interface Owner {
  owner: object;
  pubkey: string;
  onevent: (event: NostrEvent) => void;
  sub: { close(reason?: string): void } | null;
  settle(): void;
  handle: BunkerRelaySubscription;
}
interface RelayState {
  owners: Map<object, Owner>;
  publishers: number;
  relay: Relay | null;
  connecting: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
}

/**
 * Owns NIP-46 sockets and reconnect backoff across multiple BunkerServer identities.
 * Each owner has a direct relay subscription: no pool-level pre-validation dedup.
 * Keep separately routed transports (Tor, archive, NWC) in separate pools.
 */
export class BunkerRelayManager {
  readonly #pool: SimplePool;
  readonly #states = new Map<string, RelayState>();
  readonly #opts: Required<Omit<BunkerRelayManagerOptions, "websocketImplementation" | "logger">>;
  readonly #log: BunkerLogger;
  #closed = false;

  constructor(options: BunkerRelayManagerOptions = {}) {
    this.#opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 3000,
      reconnectDelayMs: options.reconnectDelayMs ?? 3000,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 60_000,
      maxRelays: options.maxRelays ?? 32,
    };
    for (const [key, value] of Object.entries(this.#opts)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive safe integer`);
    }
    this.#log = options.logger ?? {};
    if (options.websocketImplementation) useWebSocketImplementation(options.websocketImplementation);
    this.#pool = new OwnedBunkerPool();
  }

  /** Check a complete proposed relay set before the caller mutates pairing state. Opens nothing. */
  assertCapacity(relays: string[]): void {
    if (this.#closed) throw new Error("BunkerRelayManager is closed");
    const urls = normalizeRelays(relays);
    if (this.#states.size + urls.filter((url) => !this.#states.has(url)).length > this.#opts.maxRelays) {
      throw new Error(`relay limit exceeded (limit ${this.#opts.maxRelays})`);
    }
  }

  /** One subscription per opaque owner per normalized URL. Closing it never releases another owner. */
  subscribe(owner: object, rawUrl: string, connectionPubkey: string, onevent: (event: NostrEvent) => void): BunkerRelaySubscription {
    const url = normalizeRelays([rawUrl])[0]!;
    const state = this.#claim(url);
    const existing = state.owners.get(owner);
    if (existing) return existing.handle;
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => { settle = resolve; });
    const entry: Owner = {
      owner, pubkey: connectionPubkey, onevent, sub: null, settle,
      handle: { ready, close: () => this.#release(url, state, owner) },
    };
    state.owners.set(owner, entry);
    if (state.relay) this.#open(url, state, entry);
    else if (!state.timer) void this.#connect(url, state);
    return entry.handle;
  }

  /** Publish only to the caller's relay set. Temporary ownership is included in the global cap. */
  async publish(relays: string[], event: NostrEvent): Promise<void> {
    const urls = normalizeRelays(relays);
    if (!urls.length) throw new Error("no relays to publish to");
    // Admit the complete set before opening any socket; a rejected publish consumes no capacity.
    this.assertCapacity(urls);
    const claims = urls.map((url) => {
      const state = this.#claim(url);
      state.publishers++;
      return { url, state };
    });
    try {
      // Wait for every attempt to settle before releasing temporary ownership. Promise.any
      // alone returns while slow publishes are still opening sockets that nobody owns.
      const results = await Promise.allSettled(urls.map(async (url) => {
        // AbstractSimplePool.publish fulfills with a connection-failure string.
        // A fulfilled direct relay.publish is an actual OK acknowledgement.
        const relay = await this.#pool.ensureRelay(url, { connectionTimeout: this.#opts.connectTimeoutMs });
        return relay.publish(event);
      }));
      if (this.#closed) throw new Error("BunkerRelayManager is closed");
      if (!results.some((result) => result.status === "fulfilled")) throw new Error("publish failed on every relay");
    } finally {
      for (const { url, state } of claims) {
        state.publishers--;
        this.#retire(url, state);
      }
    }
  }

  /** Stop all owners, timers and sockets. Cannot be restarted. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#states];
    this.#states.clear();
    for (const [, state] of entries) {
      if (state.timer) clearTimeout(state.timer);
      for (const entry of state.owners.values()) { entry.settle(); entry.sub?.close(); }
      state.owners.clear();
    }
    this.#pool.close(entries.map(([url]) => url));
    this.#pool.destroy();
  }

  #claim(url: string): RelayState {
    if (this.#closed) throw new Error("BunkerRelayManager is closed");
    let state = this.#states.get(url);
    if (!state) {
      if (this.#states.size >= this.#opts.maxRelays) throw new Error(`relay limit exceeded (limit ${this.#opts.maxRelays})`);
      state = { owners: new Map(), publishers: 0, relay: null, connecting: null, timer: null, failures: 0 };
      this.#states.set(url, state);
    }
    return state;
  }

  #release(url: string, state: RelayState, owner: object): void {
    const entry = state.owners.get(owner);
    if (!entry) return;
    state.owners.delete(owner);
    entry.settle();
    const sub = entry.sub;
    entry.sub = null;
    sub?.close();
    this.#retire(url, state);
  }

  #retire(url: string, state: RelayState): void {
    if (state.owners.size || state.publishers || this.#states.get(url) !== state) return;
    this.#states.delete(url);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    this.#pool.close([url]);
  }

  #connect(url: string, state: RelayState): Promise<void> {
    if (state.connecting) return state.connecting;
    const attempt = async () => {
      try {
        const relay = await this.#pool.ensureRelay(url, { connectionTimeout: this.#opts.connectTimeoutMs });
        if (this.#closed || this.#states.get(url) !== state) {
          if (!this.#states.has(url)) this.#pool.close([url]);
          return;
        }
        state.relay = relay;
        for (const entry of state.owners.values()) if (!entry.sub) this.#open(url, state, entry);
      } catch {
        for (const entry of state.owners.values()) entry.settle();
        this.#retry(url, state);
      } finally {
        state.connecting = null;
      }
    };
    state.connecting = attempt();
    return state.connecting;
  }

  #open(url: string, state: RelayState, entry: Owner): void {
    if (!state.relay || entry.sub) return;
    const sub = state.relay.subscribe([{ kinds: [NostrConnect], "#p": [entry.pubkey] }], {
      // Never mark raw ids seen here. BunkerServer verifies before its bounded dedup.
      alreadyHaveEvent: () => false,
      onevent: (event) => {
        if (!this.#closed && state.owners.get(entry.owner) === entry && entry.sub === sub) entry.onevent(event);
      },
      oneose: () => { state.failures = 0; entry.settle(); },
      onclose: () => {
        if (entry.sub !== sub) return;
        entry.sub = null;
        entry.settle();
        this.#retry(url, state);
      },
    });
    entry.sub = sub;
  }

  #retry(url: string, state: RelayState): void {
    if (this.#closed || this.#states.get(url) !== state || !state.owners.size || state.timer) return;
    state.relay = null;
    const delayMs = Math.min(this.#opts.reconnectDelayMs * 2 ** Math.min(state.failures++, 10), this.#opts.maxReconnectDelayMs);
    this.#log.warn?.("relay subscription closed; retrying", { relay: url, delayMs });
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.#states.get(url) === state) void this.#connect(url, state);
    }, delayMs);
  }
}
