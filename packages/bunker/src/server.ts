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
import {
  BunkerError,
  type BunkerErrorMapper,
  type BunkerHandler,
  type BunkerLogger,
  type BunkerRequest,
  type BunkerRequestContext,
  type BunkerServerOptions,
  type BunkerUri,
  type NostrConnectPairing,
} from "./types";

const DEFAULTS = {
  requireSecret: true,
  handlerTimeoutMs: 120_000,
  reconnectDelayMs: 3000,
  maxReconnectDelayMs: 60_000,
  maxClockSkewSec: 300,
  seenCapacity: 256,
  strangerCapacity: 256,
};

/** The owner tag for relays the host configured, as opposed to a client's own. */
const SERVER_OWNER = "server";

interface ClientState {
  connectedAt: number;
  secret?: string;
  /** Where this client listens. Its responses go here and nowhere else. */
  relays: string[];
  convKey: Uint8Array;
  seen: BoundedSet;
}

interface SecretState {
  /** Relays advertised alongside this secret (a `bunker://` URI's, or a `nostrconnect://` URI's). */
  relays: string[];
  /** The client that presented this secret first. Set synchronously, before any approval awaits. */
  clientPubkey?: string;
  /** True once the handler approved that client's `connect`. */
  confirmed: boolean;
}

interface RelaySubscription {
  closer: SubCloser | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  /** `SERVER_OWNER` and/or client pubkeys. The subscription lives while this is non-empty. */
  owners: Set<string>;
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
 * Relays are kept per client. A client's responses go to the relays it was
 * paired on (the `bunker://` URI's for a bunker-initiated pairing, the
 * `nostrconnect://` URI's for a client-initiated one) and to no relay another
 * client introduced. `switch_relays` answers with that same per-client set.
 *
 * Built-ins the transport answers itself: `connect` (secret verification, then
 * the handler decides), `ping`, `switch_relays`. Everything else, including
 * methods this package has never heard of, goes to the handler.
 */
export class BunkerServer {
  readonly #sk: Uint8Array;
  readonly #pubkey: string;
  readonly #handler: BunkerHandler;
  readonly #mapError: BunkerErrorMapper;
  readonly #log: BunkerLogger;
  readonly #opts: typeof DEFAULTS;
  readonly #relayPool: RelayPool;
  readonly #ownsPool: boolean;
  readonly #subs = new Map<string, RelaySubscription>();
  readonly #clients = new Map<string, ClientState>();
  readonly #secrets = new Map<string, SecretState>();
  /** Dedup windows for senders that have not connected; bounded in both dimensions. */
  readonly #strangers = new Map<string, BoundedSet>();
  #started = false;
  #stopped = false;

  constructor(options: BunkerServerOptions) {
    this.#sk = typeof options.connectionSecretKey === "string"
      ? hexToBytes(options.connectionSecretKey)
      : options.connectionSecretKey;
    if (this.#sk.length !== 32) throw new Error("connectionSecretKey must be 32 bytes");
    this.#pubkey = getPublicKey(this.#sk);
    this.#handler = options.handler;
    this.#mapError = options.mapError ?? defaultMapError;
    this.#log = options.logger ?? {};
    this.#opts = {
      requireSecret: options.requireSecret ?? DEFAULTS.requireSecret,
      handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULTS.handlerTimeoutMs,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs,
      maxClockSkewSec: options.maxClockSkewSec ?? DEFAULTS.maxClockSkewSec,
      seenCapacity: options.seenCapacity ?? DEFAULTS.seenCapacity,
      strangerCapacity: options.strangerCapacity ?? DEFAULTS.strangerCapacity,
    };
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

  /** The host-configured relays: the constructor's plus any from `addRelay` or `createBunkerUri`. */
  get relays(): string[] {
    return this.#relayPool.getUrls();
  }

  /** Every relay currently subscribed on, host-configured and client-introduced alike. */
  get listeningRelays(): string[] {
    return [...this.#subs.keys()];
  }

  /** Clients that completed `connect` (or were paired via `nostrconnect://`). */
  get connectedClients(): string[] {
    return [...this.#clients.keys()];
  }

  isConnected(clientPubkey: string): boolean {
    return this.#clients.has(clientPubkey);
  }

  /** The relays a connected client's responses go to; `[]` for a client that is not connected. */
  relaysFor(clientPubkey: string): string[] {
    return [...(this.#clients.get(clientPubkey)?.relays ?? [])];
  }

  /** Forget a client. Its next request is refused until it connects again; relays only it used are dropped. */
  disconnectClient(clientPubkey: string): void {
    const client = this.#clients.get(clientPubkey);
    if (!client) return;
    this.#clients.delete(clientPubkey);
    for (const url of client.relays) this.#release(url, clientPubkey);
  }

  /**
   * Issue a `bunker://` URI with a fresh pairing secret (or the one given).
   * The secret is bound to the first client that presents it; another client
   * presenting the same secret is refused. The same client may present it
   * again on every reconnect. Relays named here are host-chosen and join the
   * listening set; the client paired with this secret is answered on them.
   */
  createBunkerUri(options: { relays?: string[]; secret?: string } = {}): BunkerUri {
    const secret = options.secret ?? randomHex(16);
    const relays = dedupe(options.relays && options.relays.length > 0 ? options.relays : this.relays);
    for (const url of relays) this.addRelay(url);
    const existing = this.#secrets.get(secret);
    if (existing) {
      existing.relays = relays;
    } else {
      this.#secrets.set(secret, { relays, confirmed: false });
    }
    return { uri: createBunkerUri({ pubkey: this.#pubkey, relays, secret }), secret };
  }

  /**
   * Accept a client-generated `nostrconnect://` URI (the QR flow). The handler
   * sees a synthetic `connect` request carrying the URI's secret, perms and
   * metadata; if it resolves, the client is marked connected, the server
   * subscribes on the URI's relays for that client alone, and the encrypted
   * acknowledgement (`result` set to the client's secret, as the client
   * verifies) is published to those relays. If the handler rejects, nothing is
   * sent and the rejection propagates to the caller.
   */
  async acceptNostrConnect(uri: string): Promise<NostrConnectPairing> {
    const parsed = parseNostrConnectUri(uri);
    const existing = this.#secrets.get(parsed.secret);
    if (existing && existing.clientPubkey !== parsed.clientPubkey) {
      throw new BunkerError("secret already in use");
    }
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
    await this.#runHandler(request);

    this.#secrets.set(parsed.secret, { relays: parsed.relays, clientPubkey: parsed.clientPubkey, confirmed: true });
    await this.#admit(parsed.clientPubkey, parsed.secret, parsed.relays);
    this.#log.info?.("nostrconnect: client paired", { clientPubkey: parsed.clientPubkey, relays: parsed.relays });
    await this.#send(parsed.clientPubkey, { id: request.id, result: parsed.secret }, parsed.relays);
    return { ...parsed, requestId: request.id };
  }

  /** Listen on a host-chosen relay that was not in the initial set. Safe to call repeatedly. */
  addRelay(url: string): void {
    this.#relayPool.addRelay(url);
    if (this.#started && !this.#stopped) void this.#subscribe(url, SERVER_OWNER);
    else this.#claim(url, SERVER_OWNER);
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
    for (const url of this.relays) this.#claim(url, SERVER_OWNER);
    await Promise.all([...this.#subs.keys()].map((url) => this.#subscribe(url)));
  }

  /** Close every subscription and, for a pool this server created, the pool. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const urls = [...this.#subs.keys()];
    for (const [url, sub] of this.#subs) {
      if (sub.timer) clearTimeout(sub.timer);
      sub.timer = null;
      try {
        sub.closer?.close();
      } catch (err) {
        this.#log.debug?.("close failed", { relay: url, error: errorText(err) });
      }
      sub.closer = null;
    }
    this.#subs.clear();
    if (this.#ownsPool) {
      this.#relayPool.getPool()?.close(urls);
      this.#relayPool.destroy();
    }
  }

  // ── Subscriptions ──

  /** Record `owner`'s interest in `url` without opening anything. */
  #claim(url: string, owner: string): RelaySubscription {
    let state = this.#subs.get(url);
    if (!state) {
      state = { closer: null, timer: null, failures: 0, owners: new Set() };
      this.#subs.set(url, state);
    }
    state.owners.add(owner);
    return state;
  }

  /** Drop `owner`'s interest in `url`; close the subscription when nobody is left. */
  #release(url: string, owner: string): void {
    const state = this.#subs.get(url);
    if (!state) return;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    this.#subs.delete(url);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    try {
      state.closer?.close();
    } catch (err) {
      this.#log.debug?.("close failed", { relay: url, error: errorText(err) });
    }
    state.closer = null;
    if (this.#ownsPool) this.#relayPool.getPool()?.close([url]);
    this.#log.debug?.("relay released", { relay: url });
  }

  #subscribe(url: string, owner?: string): Promise<void> {
    const pool = this.#relayPool.getPool();
    if (!pool || this.#stopped) return Promise.resolve();
    const state = owner ? this.#claim(url, owner) : this.#subs.get(url);
    if (!state) return Promise.resolve();
    if (state.closer) return Promise.resolve();

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
          this.#onEvent(event, url);
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
    if (this.#subs.get(url) !== state) return;
    const delay = Math.min(
      this.#opts.reconnectDelayMs * 2 ** Math.min(state.failures, 10),
      this.#opts.maxReconnectDelayMs,
    );
    state.failures += 1;
    this.#log.warn?.("relay subscription closed; retrying", { relay: url, reason, delayMs: delay });
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.#stopped || this.#subs.get(url) !== state) return;
      void this.#subscribe(url);
    }, delay);
  }

  // ── Inbound ──

  #onEvent(event: NostrEvent, sourceRelay: string): void {
    if (this.#stopped) return;
    if (event.kind !== NostrConnect) return;
    if (!event.tags.some((t) => t[0] === "p" && t[1] === this.#pubkey)) return;
    const clientPubkey = event.pubkey;
    if (this.#seen(clientPubkey, `e:${event.id}`)) return;
    if (!verifyEvent(event as never)) {
      this.#log.warn?.("dropped request with invalid signature", { clientPubkey });
      return;
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
    if (skew > this.#opts.maxClockSkewSec) {
      this.#log.warn?.("dropped request outside the clock-skew limit", { clientPubkey, skewSec: skew });
      return;
    }

    const convKey = this.#conversationKey(clientPubkey);
    let message: unknown;
    try {
      message = decryptPayload(event.content, convKey);
    } catch {
      this.#log.warn?.("dropped request that could not be decrypted", { clientPubkey });
      return;
    }

    const request = parseRequest(message);
    if (!request) {
      const id = extractId(message);
      this.#log.warn?.("malformed request", { clientPubkey, id });
      if (id) void this.#send(clientPubkey, { id, error: "invalid request" }, [sourceRelay]);
      return;
    }

    if (this.#seen(clientPubkey, `r:${request.id}`)) {
      this.#log.debug?.("duplicate request ignored", { clientPubkey, id: request.id, method: request.method });
      return;
    }

    // Deliberately not awaited: requests are independent and a slow one must
    // not hold up the next.
    void this.#dispatch(clientPubkey, request, sourceRelay);
  }

  /** Per-sender dedup. Connected clients keep their own window; strangers share a bounded pool of them. */
  #seen(pubkey: string, key: string): boolean {
    const client = this.#clients.get(pubkey);
    if (client) return client.seen.addIfNew(key);
    let set = this.#strangers.get(pubkey);
    if (!set) {
      set = new BoundedSet(this.#opts.seenCapacity);
      this.#strangers.set(pubkey, set);
      if (this.#strangers.size > this.#opts.strangerCapacity) {
        const oldest = this.#strangers.keys().next().value;
        if (oldest !== undefined) this.#strangers.delete(oldest);
      }
    }
    return set.addIfNew(key);
  }

  async #dispatch(clientPubkey: string, parsed: ParsedRequest, sourceRelay: string): Promise<void> {
    const request: BunkerRequest = { ...parsed, clientPubkey };
    this.#log.debug?.("request", { clientPubkey, id: request.id, method: request.method });
    let result: string;
    try {
      if (request.method === "ping") {
        result = "pong";
      } else if (request.method === "connect") {
        result = await this.#connect(request, sourceRelay);
      } else if (!this.#clients.has(clientPubkey)) {
        throw new BunkerError("unauthorized: connect first");
      } else if (request.method === "switch_relays") {
        result = JSON.stringify(this.relaysFor(clientPubkey));
      } else {
        result = await this.#runHandler(request);
      }
    } catch (err) {
      const error = this.#wireError(err, request);
      this.#log.info?.("request refused", { clientPubkey, id: request.id, method: request.method, error });
      await this.#send(clientPubkey, { id: request.id, error }, this.#clients.get(clientPubkey)?.relays ?? [sourceRelay]);
      return;
    }
    await this.#send(clientPubkey, { id: request.id, result }, this.#clients.get(clientPubkey)?.relays ?? [sourceRelay]);
    // After the ack, not before: disconnecting first would release the client's
    // relays and then re-open one of them just to deliver this response.
    if (request.method === "logout") this.disconnectClient(clientPubkey);
  }

  async #connect(request: BunkerRequest, sourceRelay: string): Promise<string> {
    const secret = request.params[1] ?? "";
    let record = secret ? this.#secrets.get(secret) : undefined;
    if (this.#opts.requireSecret && !record) throw new BunkerError("invalid secret");
    if (record?.clientPubkey && record.clientPubkey !== request.clientPubkey) {
      throw new BunkerError("secret already used by another client");
    }
    // Bind before the approval await, so a second client presenting the same
    // secret while this one is pending is refused rather than raced in.
    const claimed = record !== undefined && record.clientPubkey === undefined;
    if (record && claimed) record.clientPubkey = request.clientPubkey;
    try {
      await this.#runHandler(request);
    } catch (err) {
      if (record && claimed && !record.confirmed) delete record.clientPubkey;
      throw err;
    }
    if (record) record.confirmed = true;
    await this.#admit(request.clientPubkey, secret || undefined, record?.relays ?? [sourceRelay]);
    this.#log.info?.("client connected", { clientPubkey: request.clientPubkey });
    return "ack";
  }

  /** Mark a client connected, pinning its dedup window and its relay set. Resolves once its relays are subscribed. */
  async #admit(clientPubkey: string, secret: string | undefined, relays: string[]): Promise<void> {
    const previous = this.#clients.get(clientPubkey);
    const relaySet = dedupe(relays);
    const seen = previous?.seen ?? this.#strangers.get(clientPubkey) ?? new BoundedSet(this.#opts.seenCapacity);
    this.#strangers.delete(clientPubkey);
    this.#clients.set(clientPubkey, {
      connectedAt: Date.now(),
      ...(secret ? { secret } : {}),
      relays: relaySet,
      convKey: previous?.convKey ?? conversationKey(this.#sk, clientPubkey),
      seen,
    });
    if (previous) {
      for (const url of previous.relays) if (!relaySet.includes(url)) this.#release(url, clientPubkey);
    }
    if (this.#started && !this.#stopped) {
      await Promise.all(relaySet.map((url) => this.#subscribe(url, clientPubkey)));
    } else {
      for (const url of relaySet) this.#claim(url, clientPubkey);
    }
  }

  async #runHandler(request: BunkerRequest): Promise<string> {
    const context = this.#contextFor(request);
    const limit = this.#opts.handlerTimeoutMs;
    if (limit <= 0) return this.#handler(request, context);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BunkerError("request timed out")), limit);
    });
    try {
      return await Promise.race([this.#handler(request, context), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #wireError(err: unknown, request: BunkerRequest): string {
    try {
      const text = this.#mapError(err, request);
      return typeof text === "string" && text.length > 0 ? text : "request rejected";
    } catch {
      return "request rejected";
    }
  }

  #contextFor(request: BunkerRequest): BunkerRequestContext {
    let authUrlSent = false;
    return {
      sendAuthUrl: async (url: string) => {
        if (authUrlSent) throw new Error("auth_url already sent for this request");
        authUrlSent = true;
        const relays = this.#clients.get(request.clientPubkey)?.relays
          ?? this.#secrets.get(request.params[1] ?? "")?.relays
          ?? this.relays;
        await this.#send(request.clientPubkey, { id: request.id, result: "auth_url", error: url }, relays);
      },
    };
  }

  // ── Outbound ──

  async #send(clientPubkey: string, payload: ResponsePayload, relays: string[]): Promise<void> {
    if (this.#stopped) return;
    const event = buildResponseEvent(this.#sk, clientPubkey, this.#conversationKey(clientPubkey), payload);
    try {
      await publishAny(this.#relayPool.getPool(), relays, event);
    } catch (err) {
      this.#log.error?.("response could not be published to any relay", {
        clientPubkey,
        id: payload.id,
        relays,
        error: errorText(err),
      });
    }
  }

  /** Cached for connected clients only; anyone else costs one ECDH per event and nothing afterwards. */
  #conversationKey(peerPubkey: string): Uint8Array {
    return this.#clients.get(peerPubkey)?.convKey ?? conversationKey(this.#sk, peerPubkey);
  }
}

function defaultMapError(err: unknown): string {
  if (err instanceof Error && (err as { wireVisible?: unknown }).wireVisible === true && err.message) {
    return err.message;
  }
  return "request rejected";
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

/** For the log only; never sent to a client. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "unknown error";
}
