import { RelayPool, type NostrEvent, type PoolLike, type SubCloser } from "@nostr-wot/relay";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { NostrConnect } from "nostr-tools/kinds";
import {
  buildResponseEvent,
  conversationKey,
  decryptPayload,
  extractId,
  parseRequest,
  type ParsedRequest,
  type ResponsePayload,
} from "./codec";
import { createBunkerUri, parseNostrConnectUri } from "./uri";
import type {
  BunkerHandler,
  BunkerLogger,
  BunkerRequest,
  BunkerRequestContext,
  BunkerServerOptions,
  BunkerUri,
  NostrConnectPairing,
} from "./types";

const DEFAULTS = {
  requireSecret: true,
  reconnectDelayMs: 3000,
  maxReconnectDelayMs: 60_000,
  maxClockSkewSec: 300,
  seenCapacity: 2048,
};

interface ClientState {
  connectedAt: number;
  secret?: string;
}

interface SecretState {
  /** The client that consumed this secret; a different client is refused. */
  clientPubkey?: string;
}

interface RelaySubscription {
  closer: SubCloser | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
}

/** Insertion-ordered set with a hard cap: the oldest entry goes first. */
class BoundedSet {
  readonly #map = new Map<string, true>();
  constructor(private readonly capacity: number) {}
  /** Returns `true` when the key was already present. */
  addIfNew(key: string): boolean {
    if (this.#map.has(key)) return true;
    this.#map.set(key, true);
    if (this.#map.size > this.capacity) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    return false;
  }
}

/**
 * NIP-46 responder. A transport adapter and nothing more: it owns the
 * connection key, the relay subscriptions, NIP-44 framing, pairing secrets,
 * request deduplication and response routing. Whether a request should be
 * served is the injected handler's decision alone.
 *
 * Two keys are involved and they are never conflated:
 *
 *   - the **connection key** (`connectionSecretKey`) encrypts and signs every
 *     NIP-46 message and appears in `bunker://` URIs;
 *   - the **user key** never enters this package. `get_public_key` is forwarded
 *     to the handler like any other request, and the handler answers with it.
 *
 * Built-ins the transport answers itself: `connect` (secret verification, then
 * the handler decides), `ping`, `switch_relays`. Everything else, including
 * methods this package has never heard of, goes to the handler.
 */
export class BunkerServer {
  readonly #sk: Uint8Array;
  readonly #pubkey: string;
  readonly #handler: BunkerHandler;
  readonly #log: BunkerLogger;
  readonly #opts: typeof DEFAULTS;
  readonly #relayPool: RelayPool;
  readonly #ownsPool: boolean;
  readonly #subs = new Map<string, RelaySubscription>();
  readonly #clients = new Map<string, ClientState>();
  readonly #secrets = new Map<string, SecretState>();
  readonly #convKeys = new Map<string, Uint8Array>();
  readonly #seenEvents: BoundedSet;
  readonly #seenRequests: BoundedSet;
  #started = false;
  #stopped = false;

  constructor(options: BunkerServerOptions) {
    this.#sk = typeof options.connectionSecretKey === "string"
      ? hexToBytes(options.connectionSecretKey)
      : options.connectionSecretKey;
    if (this.#sk.length !== 32) throw new Error("connectionSecretKey must be 32 bytes");
    this.#pubkey = getPublicKey(this.#sk);
    this.#handler = options.handler;
    this.#log = options.logger ?? {};
    this.#opts = {
      requireSecret: options.requireSecret ?? DEFAULTS.requireSecret,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs,
      maxClockSkewSec: options.maxClockSkewSec ?? DEFAULTS.maxClockSkewSec,
      seenCapacity: options.seenCapacity ?? DEFAULTS.seenCapacity,
    };
    this.#seenEvents = new BoundedSet(this.#opts.seenCapacity);
    this.#seenRequests = new BoundedSet(this.#opts.seenCapacity);
    if (options.relays.length === 0) throw new Error("BunkerServer needs at least one relay");
    this.#ownsPool = !options.pool;
    this.#relayPool = new RelayPool({
      urls: dedupe(options.relays),
      ...(options.pool ? { pool: options.pool } : {}),
    });
    this.#relayPool.ensurePool(() => {
      // Same mechanism @nostr-wot/graph uses: nostr-tools takes the WebSocket
      // constructor process-wide, which is what a React Native host wants anyway.
      if (options.websocketImplementation) {
        useWebSocketImplementation(options.websocketImplementation);
      }
      return new SimplePool();
    });
  }

  /** The remote-signer (transport) pubkey: what `bunker://` URIs advertise. */
  get connectionPubkey(): string {
    return this.#pubkey;
  }

  /** Relays currently listened on. */
  get relays(): string[] {
    return this.#relayPool.getUrls();
  }

  /** Clients that completed `connect` (or were paired via `nostrconnect://`). */
  get connectedClients(): string[] {
    return [...this.#clients.keys()];
  }

  isConnected(clientPubkey: string): boolean {
    return this.#clients.has(clientPubkey);
  }

  /** Forget a client. Its next request is refused until it connects again. */
  disconnectClient(clientPubkey: string): void {
    this.#clients.delete(clientPubkey);
  }

  /**
   * Issue a `bunker://` URI with a fresh pairing secret (or the one given).
   * The secret is bound to the first client that connects with it; another
   * client presenting the same secret is refused. The same client may present
   * it again on every reconnect.
   */
  createBunkerUri(options: { relays?: string[]; secret?: string } = {}): BunkerUri {
    const secret = options.secret ?? randomHex(16);
    const relays = options.relays && options.relays.length > 0 ? options.relays : this.relays;
    for (const url of relays) this.addRelay(url);
    if (!this.#secrets.has(secret)) this.#secrets.set(secret, {});
    return { uri: createBunkerUri({ pubkey: this.#pubkey, relays, secret }), secret };
  }

  /**
   * Accept a client-generated `nostrconnect://` URI (the QR flow). The handler
   * sees a synthetic `connect` request carrying the URI's secret, perms and
   * metadata; if it resolves, the client is marked connected, the URI's relays
   * join the listening set, and the encrypted acknowledgement (`result` set to
   * the client's secret, as the client verifies) is published where the client
   * is listening. If the handler rejects, nothing is sent and the rejection
   * propagates to the caller.
   */
  async acceptNostrConnect(uri: string): Promise<NostrConnectPairing> {
    const parsed = parseNostrConnectUri(uri);
    const metadata: Record<string, string> = {};
    if (parsed.name) metadata.name = parsed.name;
    if (parsed.url) metadata.url = parsed.url;
    if (parsed.image) metadata.image = parsed.image;
    const request: BunkerRequest = {
      id: randomHex(8),
      clientPubkey: parsed.clientPubkey,
      method: "connect",
      params: [this.#pubkey, parsed.secret, parsed.perms.join(","), JSON.stringify(metadata)],
    };
    await this.#handler(request, this.#contextFor(request));

    for (const url of parsed.relays) this.addRelay(url);
    this.#secrets.set(parsed.secret, { clientPubkey: parsed.clientPubkey });
    this.#clients.set(parsed.clientPubkey, { connectedAt: Date.now(), secret: parsed.secret });
    this.#log.info?.("nostrconnect: client paired", { clientPubkey: parsed.clientPubkey, relays: parsed.relays });
    await this.#send(parsed.clientPubkey, { id: request.id, result: parsed.secret }, dedupe([...parsed.relays, ...this.relays]));
    return { ...parsed, requestId: request.id };
  }

  /** Listen on a relay that was not in the initial set. Safe to call repeatedly. */
  addRelay(url: string): void {
    const added = this.#relayPool.addRelay(url);
    if (added && this.#started && !this.#stopped) this.#subscribe(url);
  }

  /**
   * Open the subscriptions. Resolves once every relay has either answered the
   * subscription (EOSE) or failed its first attempt; failed relays keep
   * retrying in the background.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("BunkerServer cannot be restarted after stop()");
    this.#started = true;
    await Promise.all(this.relays.map((url) => this.#subscribe(url)));
  }

  /** Close every subscription and, for a pool this server created, the pool. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const [url, sub] of this.#subs) {
      if (sub.timer) clearTimeout(sub.timer);
      sub.timer = null;
      try {
        sub.closer?.close();
      } catch (err) {
        this.#log.debug?.("close failed", { relay: url, error: errorMessage(err) });
      }
      sub.closer = null;
    }
    this.#subs.clear();
    if (this.#ownsPool) this.#relayPool.destroy();
  }

  // ── Subscriptions ──

  #subscribe(url: string): Promise<void> {
    const pool = this.#relayPool.getPool();
    if (!pool || this.#stopped) return Promise.resolve();
    const state: RelaySubscription = this.#subs.get(url) ?? { closer: null, timer: null, failures: 0 };
    this.#subs.set(url, state);

    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      let closer: SubCloser | null = null;
      closer = this.#subscribeToPool(pool, url, {
        onevent: (event: NostrEvent) => {
          this.#onEvent(event);
        },
        oneose: () => {
          state.failures = 0;
          this.#log.debug?.("subscribed", { relay: url });
          settle();
        },
        onclose: (reasons) => {
          if (state.closer === closer) state.closer = null;
          settle();
          this.#scheduleResubscribe(url, state, reasons.map((r) => r.reason).join("; "));
        },
      });
      state.closer = closer;
    });
  }

  #subscribeToPool(
    pool: PoolLike,
    url: string,
    params: {
      onevent: (e: NostrEvent) => void;
      oneose: () => void;
      onclose: (reasons: { url: string; reason: string }[]) => void;
    },
  ): SubCloser {
    return pool.subscribe([url], { kinds: [NostrConnect], "#p": [this.#pubkey] }, params);
  }

  #scheduleResubscribe(url: string, state: RelaySubscription, reason: string): void {
    if (this.#stopped || state.timer) return;
    if (!this.relays.includes(url)) return;
    const delay = Math.min(
      this.#opts.reconnectDelayMs * 2 ** Math.min(state.failures, 10),
      this.#opts.maxReconnectDelayMs,
    );
    state.failures += 1;
    this.#log.warn?.("relay subscription closed; retrying", { relay: url, reason, delayMs: delay });
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.#stopped) return;
      void this.#subscribe(url);
    }, delay);
  }

  // ── Inbound ──

  #onEvent(event: NostrEvent): void {
    if (this.#stopped) return;
    if (event.kind !== NostrConnect) return;
    if (!event.tags.some((t) => t[0] === "p" && t[1] === this.#pubkey)) return;
    if (this.#seenEvents.addIfNew(event.id)) return;
    if (!verifyEvent(event as never)) {
      this.#log.warn?.("dropped request with invalid signature", { clientPubkey: event.pubkey });
      return;
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
    if (skew > this.#opts.maxClockSkewSec) {
      this.#log.warn?.("dropped request outside the clock-skew limit", {
        clientPubkey: event.pubkey,
        skewSec: skew,
      });
      return;
    }

    const clientPubkey = event.pubkey;
    let message: unknown;
    try {
      message = decryptPayload(event.content, this.#conversationKey(clientPubkey));
    } catch {
      this.#log.warn?.("dropped request that could not be decrypted", { clientPubkey });
      return;
    }

    const request = parseRequest(message);
    if (!request) {
      const id = extractId(message);
      this.#log.warn?.("malformed request", { clientPubkey, id });
      if (id) void this.#send(clientPubkey, { id, error: "invalid request" });
      return;
    }

    if (this.#seenRequests.addIfNew(`${clientPubkey}:${request.id}`)) {
      this.#log.debug?.("duplicate request ignored", { clientPubkey, id: request.id, method: request.method });
      return;
    }

    // Deliberately not awaited: requests are independent and a slow one must
    // not hold up the next.
    void this.#dispatch(clientPubkey, request);
  }

  async #dispatch(clientPubkey: string, parsed: ParsedRequest): Promise<void> {
    const request: BunkerRequest = { ...parsed, clientPubkey };
    const context = this.#contextFor(request);
    this.#log.debug?.("request", { clientPubkey, id: request.id, method: request.method });
    let result: string;
    try {
      if (request.method === "connect") {
        result = await this.#connect(request, context);
      } else if (!this.#clients.has(clientPubkey)) {
        throw new Error("unauthorized: connect first");
      } else if (request.method === "ping") {
        result = "pong";
      } else if (request.method === "switch_relays") {
        result = JSON.stringify(this.relays);
      } else {
        result = await this.#handler(request, context);
        if (request.method === "logout") this.#clients.delete(clientPubkey);
      }
    } catch (err) {
      const error = errorMessage(err);
      this.#log.info?.("request refused", { clientPubkey, id: request.id, method: request.method, error });
      await this.#send(clientPubkey, { id: request.id, error });
      return;
    }
    await this.#send(clientPubkey, { id: request.id, result });
  }

  async #connect(request: BunkerRequest, context: BunkerRequestContext): Promise<string> {
    const secret = request.params[1] ?? "";
    let record: SecretState | undefined;
    if (this.#opts.requireSecret) {
      record = secret ? this.#secrets.get(secret) : undefined;
      if (!record) throw new Error("invalid secret");
      if (record.clientPubkey && record.clientPubkey !== request.clientPubkey) {
        throw new Error("secret already used by another client");
      }
    } else if (secret) {
      record = this.#secrets.get(secret);
      if (record?.clientPubkey && record.clientPubkey !== request.clientPubkey) {
        throw new Error("secret already used by another client");
      }
    }
    await this.#handler(request, context);
    if (record) record.clientPubkey = request.clientPubkey;
    this.#clients.set(request.clientPubkey, {
      connectedAt: Date.now(),
      ...(secret ? { secret } : {}),
    });
    this.#log.info?.("client connected", { clientPubkey: request.clientPubkey });
    return "ack";
  }

  #contextFor(request: BunkerRequest): BunkerRequestContext {
    let authUrlSent = false;
    return {
      sendAuthUrl: async (url: string) => {
        if (authUrlSent) throw new Error("auth_url already sent for this request");
        authUrlSent = true;
        await this.#send(request.clientPubkey, { id: request.id, result: "auth_url", error: url });
      },
    };
  }

  // ── Outbound ──

  async #send(clientPubkey: string, payload: ResponsePayload, relays?: string[]): Promise<void> {
    if (this.#stopped) return;
    const event = buildResponseEvent(this.#sk, clientPubkey, this.#conversationKey(clientPubkey), payload);
    try {
      if (relays) {
        await publishAny(this.#relayPool.getPool(), relays, event);
      } else {
        await this.#relayPool.publish(event);
      }
    } catch (err) {
      this.#log.error?.("response could not be published to any relay", {
        clientPubkey,
        id: payload.id,
        error: errorMessage(err),
      });
    }
  }

  #conversationKey(peerPubkey: string): Uint8Array {
    let key = this.#convKeys.get(peerPubkey);
    if (!key) {
      key = conversationKey(this.#sk, peerPubkey);
      this.#convKeys.set(peerPubkey, key);
    }
    return key;
  }
}

async function publishAny(pool: PoolLike | null, relays: string[], event: NostrEvent): Promise<void> {
  if (!pool) throw new Error("pool not initialized");
  const attempts = pool.publish(relays, event);
  await new Promise<void>((resolve, reject) => {
    let remaining = attempts.length;
    let settled = false;
    if (remaining === 0) {
      reject(new Error("no relays to publish to"));
      return;
    }
    for (const attempt of attempts) {
      attempt.then(
        () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        () => {
          remaining -= 1;
          if (remaining === 0 && !settled) reject(new Error("all relays rejected publish"));
        },
      );
    }
  });
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "request rejected";
  if (typeof err === "string" && err) return err;
  return "request rejected";
}
