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
import { createBunkerUri, normalizeRelays, parseNostrConnectUri } from "./uri";
import { signBunkerState, verifyBunkerState } from "./state";
import {
  BunkerError,
  type BunkerErrorMapper,
  type BunkerHandler,
  type BunkerLogger,
  type BunkerRequest,
  type BunkerRequestContext,
  type BunkerServerOptions,
  type BunkerState,
  type BunkerUri,
  type RestoreOptions,
  type UnsignedBunkerState,
  type NostrConnectPairing,
} from "./types";

const DEFAULTS = {
  requireSecret: true,
  secretTtlMs: 15 * 60_000,
  maxSecrets: 256,
  maxClients: 64,
  maxRelaysPerClient: 8,
  handlerTimeoutMs: 120_000,
  connectTimeoutMs: 3000,
  reconnectDelayMs: 3000,
  maxReconnectDelayMs: 60_000,
  maxClockSkewSec: 300,
  seenCapacity: 256,
  strangerCapacity: 256,
};

/** The owner tag for relays the host configured, as opposed to a client's own. */
const SERVER_OWNER = "server";
const HEX64 = /^[0-9a-f]{64}$/i;

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
  /** Approvals in flight for the bound client. The binding is released only when this reaches zero unconfirmed. */
  pending: number;
  /** Who minted the secret: the host (`createBunkerUri`) or a client's `nostrconnect://` URI. */
  origin: "bunker" | "nostrconnect";
  /** Unix ms; only enforced while unconfirmed. */
  expiresAt?: number;
}

interface RelaySubscription {
  closer: SubCloser | null;
  /** True while `ensureRelay` is connecting, so a second `#subscribe` does not open a second REQ. */
  connecting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  /** `SERVER_OWNER` and/or client pubkeys. The subscription lives while this is non-empty. */
  owners: Set<string>;
}

/** The one relay-level subscription shape this package uses (nostr-tools `AbstractRelay.subscribe`). */
interface RelaySubscriptionParams {
  onevent: (event: NostrEvent) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  alreadyHaveEvent?: (id: string) => boolean;
  eoseTimeout?: number;
}

interface RelayLike {
  subscribe(filters: unknown[], params: RelaySubscriptionParams): { close(reason?: string): void };
}

/** A pool that hands out its per-relay connections: nostr-tools' `AbstractSimplePool.ensureRelay`. */
interface RelayCapablePool extends PoolLike {
  ensureRelay(url: string, params?: { connectionTimeout?: number }): Promise<RelayLike>;
}

function hasEnsureRelay(pool: PoolLike): pool is RelayCapablePool {
  return typeof (pool as { ensureRelay?: unknown }).ensureRelay === "function";
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
  readonly #onStateChange: ((state: BunkerState) => void) | undefined;
  readonly #opts: typeof DEFAULTS;
  readonly #relayPool: RelayPool;
  readonly #ownsPool: boolean;
  readonly #subs = new Map<string, RelaySubscription>();
  readonly #clients = new Map<string, ClientState>();
  readonly #secrets = new Map<string, SecretState>();
  /** Dedup windows for senders that have not connected; bounded in both dimensions. */
  readonly #strangers = new Map<string, BoundedSet>();
  /** Every relay this server opened a socket to, subscribed or publish-only, so `stop()` can close them all. */
  readonly #opened = new Set<string>();
  /** `connect` and scan approvals currently inside the handler. `restore` is refused while this is non-zero. */
  #pendingApprovals = 0;
  /** Resolvers waiting for `#pendingApprovals` to reach zero. */
  #idleWaiters: Array<() => void> = [];
  /** Clients whose admission is pending and who are not connected yet; they count toward `maxClients`. */
  readonly #pendingAdmissions = new Set<string>();
  /** While a restore applies, nothing is emitted; one snapshot goes out after it succeeds. */
  #muted = false;
  /** The earliest expiry among unclaimed secrets; the sweep is a no-op before then. */
  #nextSweepAt = Number.POSITIVE_INFINITY;
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
    this.#onStateChange = options.onStateChange;
    this.#opts = {
      requireSecret: options.requireSecret ?? DEFAULTS.requireSecret,
      secretTtlMs: options.secretTtlMs ?? DEFAULTS.secretTtlMs,
      maxSecrets: options.maxSecrets ?? DEFAULTS.maxSecrets,
      maxClients: options.maxClients ?? DEFAULTS.maxClients,
      maxRelaysPerClient: options.maxRelaysPerClient ?? DEFAULTS.maxRelaysPerClient,
      handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULTS.handlerTimeoutMs,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs,
      maxClockSkewSec: options.maxClockSkewSec ?? DEFAULTS.maxClockSkewSec,
      seenCapacity: options.seenCapacity ?? DEFAULTS.seenCapacity,
      strangerCapacity: options.strangerCapacity ?? DEFAULTS.strangerCapacity,
    };
    if (options.relays.length === 0) throw new Error("BunkerServer needs at least one relay");
    this.#ownsPool = !options.pool;
    this.#relayPool = new RelayPool({
      urls: normalizeRelays(options.relays),
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

  /** `connect` and scan approvals currently inside the handler. `restore` is accepted only at zero. */
  get pendingApprovals(): number {
    return this.#pendingApprovals;
  }

  /** Resolves when no approval is pending (at once if none is), so a host knows when `restore` will be accepted. */
  whenIdle(): Promise<void> {
    if (this.#pendingApprovals === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #beginApproval(clientPubkey: string): void {
    this.#pendingApprovals += 1;
    if (!this.#clients.has(clientPubkey)) this.#pendingAdmissions.add(clientPubkey);
  }

  #endApproval(clientPubkey: string): void {
    this.#pendingApprovals -= 1;
    this.#pendingAdmissions.delete(clientPubkey);
    if (this.#pendingApprovals === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Would admitting `clientPubkey` exceed `maxClients`, counting admissions already in flight? */
  #overClientCeiling(clientPubkey: string): boolean {
    if (this.#clients.has(clientPubkey) || this.#pendingAdmissions.has(clientPubkey)) return false;
    return this.#clients.size + this.#pendingAdmissions.size >= this.#opts.maxClients;
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
    this.#emit();
  }

  /**
   * Revoke a pairing secret: `connect` with it is refused from then on
   * (`invalid secret`), an approval pending for it is discarded when the
   * handler answers (`secret revoked` goes to the client, nothing is admitted),
   * and the client bound to it, if connected through it, is disconnected.
   * Returns `false` if there was nothing to revoke.
   */
  revokeSecret(secret: string): boolean {
    const record = this.#secrets.get(secret);
    if (!record) return false;
    this.#secrets.delete(secret);
    const bound = record.clientPubkey ? this.#clients.get(record.clientPubkey) : undefined;
    if (record.clientPubkey && bound && bound.secret === secret) {
      this.disconnectClient(record.clientPubkey); // emits
    } else {
      this.#emit();
    }
    return true;
  }

  /**
   * Everything a host must persist: see {@link BunkerState}. Lapsed unclaimed
   * secrets are swept first. Hand the result to {@link restore} after a restart.
   */
  exportState(): BunkerState {
    this.#sweep();
    const secrets = [...this.#secrets].map(([secret, r]) => {
      const out: BunkerState["secrets"][number] = { secret, origin: r.origin, relays: [...r.relays], confirmed: r.confirmed };
      if (r.clientPubkey) out.clientPubkey = r.clientPubkey;
      if (r.expiresAt !== undefined) out.expiresAt = r.expiresAt;
      return out;
    });
    const clients = [...this.#clients].map(([clientPubkey, c]) => {
      const out: BunkerState["clients"][number] = { clientPubkey, relays: [...c.relays], connectedAt: c.connectedAt };
      if (c.secret) out.secret = c.secret;
      return out;
    });
    return signBunkerState(this.#sk, { version: 2, connectionPubkey: this.#pubkey, secrets, clients });
  }

  /**
   * Rehydrate what a previous process persisted, under the same connection
   * key. The state is untrusted input. In order: it must belong to this
   * connection key; it must be signed (`mac`), or `allowUnsigned` must be set
   * to migrate a pre-2 state once; no approval may be pending (a restore in the
   * middle of one would replace the record the approval is about to confirm,
   * and waiting could take as long as the host allows, so the caller retries
   * after `whenIdle()`); the MAC must verify; then the whole object is
   * validated (shape, types, relay URLs by the pairing paths' rules, pubkeys on
   * the curve, every client backed by a secret in the same state bound to it
   * and confirmed with the same relays, no duplicates, within the ceilings).
   * Only then is anything applied, all at once, with nothing emitted until it
   * has succeeded. A rejected state leaves the server exactly as it was.
   *
   * Where memory and state both hold a binding, or both hold a client, memory
   * wins: a live handshake outranks a stored record. A secret bound in memory
   * to a different client than the state says refuses the whole restore. May
   * be called before or after `start()`.
   */
  async restore(state: BunkerState, options: RestoreOptions = {}): Promise<void> {
    if (!state || typeof state !== "object") throw new Error("restore refused: state is not an object");
    if (state.connectionPubkey !== this.#pubkey) throw new Error("restore refused: state belongs to a different connection key");
    const signed = typeof (state as { mac?: unknown }).mac === "string";
    if (!signed && !options.allowUnsigned) {
      throw new Error(
        "restore refused: state is unsigned (pre-2 format); pass { allowUnsigned: true } once to migrate it, then persist the signed export",
      );
    }
    if (this.#pendingApprovals > 0) {
      throw new Error(`restore refused: ${this.#pendingApprovals} approval${this.#pendingApprovals === 1 ? "" : "s"} pending`);
    }
    if (signed && !verifyBunkerState(this.#sk, state)) throw new Error("restore refused: state authentication failed");
    const plan = this.#validateState(state);
    // Decide everything before touching anything.
    const setSecrets: Array<[string, SecretState]> = [];
    for (const [secret, incoming] of plan.secrets) {
      const current = this.#secrets.get(secret);
      if (current?.clientPubkey) {
        if (incoming.clientPubkey && incoming.clientPubkey !== current.clientPubkey) {
          throw new Error("restore refused: secret is bound to a different client in memory");
        }
        continue; // memory keeps its binding
      }
      setSecrets.push([secret, incoming]);
    }
    const admit = plan.clients.filter((c) => !this.#clients.has(c.clientPubkey));
    const secretsAfter = this.#secrets.size + setSecrets.filter(([k]) => !this.#secrets.has(k)).length;
    if (secretsAfter > this.#opts.maxSecrets) throw new Error(`restore refused: too many secrets (limit ${this.#opts.maxSecrets})`);
    if (this.#clients.size + this.#pendingAdmissions.size + admit.length > this.#opts.maxClients) {
      throw new Error(`restore refused: too many clients (limit ${this.#opts.maxClients})`);
    }
    // Apply, synchronously and silently: no await and no emission between the first mutation and the last.
    this.#muted = true;
    let admitted: Promise<void>[];
    try {
      for (const [secret, record] of setSecrets) {
        this.#secrets.set(secret, record);
        if (record.expiresAt !== undefined && !record.confirmed) this.#scheduleSweep(record.expiresAt);
      }
      admitted = admit.map((c) => this.#admit(c.clientPubkey, c.secret, c.relays, c.connectedAt, c.convKey));
    } finally {
      this.#muted = false;
    }
    this.#emit();
    this.#log.info?.("state restored", { secrets: this.#secrets.size, clients: this.#clients.size, signed });
    await Promise.all(admitted);
  }

  /** Validate and normalize a state without touching anything. Throws on the first problem. */
  #validateState(state: UnsignedBunkerState): {
    secrets: Map<string, SecretState>;
    clients: Array<{ clientPubkey: string; secret?: string; relays: string[]; connectedAt: number; convKey: Uint8Array }>;
  } {
    if (!Array.isArray(state.secrets) || !Array.isArray(state.clients)) throw new Error("restore refused: secrets and clients must be arrays");
    const relaysOf = (raw: unknown, what: string): string[] => {
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((u) => typeof u === "string")) {
        throw new Error(`restore refused: ${what} needs at least one relay`);
      }
      let relays: string[];
      try {
        relays = normalizeRelays(raw as string[]);
      } catch {
        throw new Error(`restore refused: ${what} has an invalid relay URL`);
      }
      if (relays.length > this.#opts.maxRelaysPerClient) {
        throw new Error(`restore refused: ${what} has too many relays (limit ${this.#opts.maxRelaysPerClient})`);
      }
      return relays;
    };
    // The same operation #admit needs; a 64-hex string that is not an x coordinate on secp256k1 fails here, harmlessly.
    const convKeyOf = (pubkey: string, what: string): Uint8Array => {
      try {
        return conversationKey(this.#sk, pubkey);
      } catch {
        throw new Error(`restore refused: ${what} pubkey is not on the curve`);
      }
    };
    const now = Date.now();
    const secrets = new Map<string, SecretState>();
    for (const r of state.secrets) {
      if (!r || typeof r !== "object") throw new Error("restore refused: secret record is not an object");
      if (typeof r.secret !== "string" || r.secret.length === 0 || r.secret.length > 256) throw new Error("restore refused: secret must be a string of 1 to 256 characters");
      if (secrets.has(r.secret)) throw new Error("restore refused: duplicate secret");
      if (r.origin !== "bunker" && r.origin !== "nostrconnect") throw new Error("restore refused: secret origin must be bunker or nostrconnect");
      if (typeof r.confirmed !== "boolean") throw new Error("restore refused: secret confirmed must be a boolean");
      if (r.clientPubkey !== undefined && (typeof r.clientPubkey !== "string" || !HEX64.test(r.clientPubkey))) {
        throw new Error("restore refused: secret clientPubkey must be 64 hex characters");
      }
      if (r.confirmed && !r.clientPubkey) throw new Error("restore refused: a confirmed secret needs a clientPubkey");
      if (r.expiresAt !== undefined && (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt))) {
        throw new Error("restore refused: secret expiresAt must be a finite number");
      }
      const label = `secret ${r.secret.slice(0, 8)}`;
      const record: SecretState = { relays: relaysOf(r.relays, label), confirmed: r.confirmed, pending: 0, origin: r.origin };
      if (r.clientPubkey) {
        record.clientPubkey = r.clientPubkey.toLowerCase();
        convKeyOf(record.clientPubkey, label);
      }
      if (r.expiresAt !== undefined) record.expiresAt = r.expiresAt;
      if (!record.confirmed && record.expiresAt !== undefined && record.expiresAt <= now) continue; // lapsed: drop, do not fail
      // An unconfirmed record with no expiry (a process that died mid-approval) gets the default TTL; the live path never holds one.
      if (!record.confirmed && record.expiresAt === undefined && this.#opts.secretTtlMs > 0) record.expiresAt = now + this.#opts.secretTtlMs;
      secrets.set(r.secret, record);
    }
    if (secrets.size > this.#opts.maxSecrets) throw new Error(`restore refused: too many secrets (limit ${this.#opts.maxSecrets})`);
    const clients: Array<{ clientPubkey: string; secret?: string; relays: string[]; connectedAt: number; convKey: Uint8Array }> = [];
    const seenClients = new Set<string>();
    for (const c of state.clients) {
      if (!c || typeof c !== "object") throw new Error("restore refused: client record is not an object");
      if (typeof c.clientPubkey !== "string" || !HEX64.test(c.clientPubkey)) throw new Error("restore refused: client clientPubkey must be 64 hex characters");
      const clientPubkey = c.clientPubkey.toLowerCase();
      if (seenClients.has(clientPubkey)) throw new Error("restore refused: duplicate client");
      seenClients.add(clientPubkey);
      if (typeof c.connectedAt !== "number" || !Number.isFinite(c.connectedAt)) throw new Error("restore refused: client connectedAt must be a finite number");
      const label = `client ${clientPubkey.slice(0, 8)}`;
      const relays = relaysOf(c.relays, label);
      if (c.secret === undefined) {
        if (this.#opts.requireSecret) throw new Error("restore refused: a client needs the secret it paired with");
      } else {
        if (typeof c.secret !== "string") throw new Error("restore refused: client secret must be a string");
        const bound = secrets.get(c.secret);
        if (!bound || bound.clientPubkey !== clientPubkey || !bound.confirmed) {
          throw new Error("restore refused: a client's secret must be in the state, bound to that client and confirmed");
        }
        if (bound.relays.length !== relays.length || bound.relays.some((u) => !relays.includes(u))) {
          throw new Error("restore refused: client relays differ from its secret's relays");
        }
      }
      const convKey = convKeyOf(clientPubkey, label);
      clients.push({ clientPubkey, relays, connectedAt: c.connectedAt, convKey, ...(c.secret !== undefined ? { secret: c.secret } : {}) });
    }
    if (clients.length > this.#opts.maxClients) throw new Error(`restore refused: too many clients (limit ${this.#opts.maxClients})`);
    return { secrets, clients };
  }

  /**
   * Issue a `bunker://` URI with a fresh pairing secret (or the one given).
   * The secret is bound to the first client that presents it; another client
   * presenting the same secret is refused. The same client may present it
   * again on every reconnect. Relays named here are host-chosen and join the
   * listening set; the client paired with this secret is answered on them.
   */
  createBunkerUri(options: { relays?: string[]; secret?: string; ttlMs?: number } = {}): BunkerUri {
    this.#sweep();
    const secret = options.secret ?? randomHex(16);
    const relays = normalizeRelays(options.relays && options.relays.length > 0 ? options.relays : this.relays);
    for (const url of relays) this.addRelay(url);
    const ttl = options.ttlMs ?? this.#opts.secretTtlMs;
    const existing = this.#secrets.get(secret);
    if (existing) {
      // Re-minting a known secret (a host redisplaying a stored URI) keeps its binding, and a
      // bound one keeps its relays too: the paired client is answered where it was paired.
      if (!existing.clientPubkey) existing.relays = relays;
    } else {
      if (this.#secrets.size >= this.#opts.maxSecrets) {
        throw new Error(`too many secrets (limit ${this.#opts.maxSecrets}): revoke some or wait for unclaimed ones to lapse`);
      }
      const record: SecretState = { relays, confirmed: false, pending: 0, origin: "bunker" };
      if (ttl > 0) {
        record.expiresAt = Date.now() + ttl;
        this.#scheduleSweep(record.expiresAt);
      }
      this.#secrets.set(secret, record);
    }
    this.#emit();
    return { uri: createBunkerUri({ pubkey: this.#pubkey, relays, secret }), secret };
  }

  /**
   * Drop unclaimed secrets past their expiry. Confirmed bindings and pending
   * approvals are never touched. O(1) until the earliest expiry has passed,
   * so calling it on every mint and export costs nothing in the common case;
   * it is never called on behalf of an unauthenticated request.
   */
  #sweep(): void {
    const now = Date.now();
    if (now < this.#nextSweepAt) return;
    let next = Number.POSITIVE_INFINITY;
    let changed = false;
    for (const [secret, r] of this.#secrets) {
      if (r.confirmed || r.expiresAt === undefined) continue;
      if (r.pending === 0 && r.expiresAt <= now) {
        this.#secrets.delete(secret);
        changed = true;
      } else if (r.expiresAt < next) {
        next = r.pending === 0 ? r.expiresAt : Math.max(r.expiresAt, now + 1000);
      }
    }
    this.#nextSweepAt = next;
    if (changed) this.#emit();
  }

  #scheduleSweep(expiresAt: number): void {
    if (expiresAt < this.#nextSweepAt) this.#nextSweepAt = expiresAt;
  }

  /**
   * The record for `secret` if it is still live: an unclaimed one past its
   * expiry is dropped here, on the spot, so an unauthenticated `connect` pays
   * for one lookup and never for a sweep of the whole set.
   */
  #liveSecret(secret: string): SecretState | undefined {
    const record = this.#secrets.get(secret);
    if (!record) return undefined;
    if (!record.confirmed && record.pending === 0 && record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.#secrets.delete(secret);
      this.#emit();
      return undefined;
    }
    return record;
  }

  #emit(): void {
    if (!this.#onStateChange || this.#muted) return;
    try {
      this.#onStateChange(this.exportState());
    } catch (err) {
      this.#log.warn?.("onStateChange threw", { error: errorText(err) });
    }
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
    const parsed = parseNostrConnectUri(uri, { maxRelays: this.#opts.maxRelaysPerClient });
    this.#liveSecret(parsed.secret);
    if (this.#overClientCeiling(parsed.clientPubkey)) {
      throw new Error(`too many clients (limit ${this.#opts.maxClients}): disconnect some first`);
    }
    if (!this.#secrets.has(parsed.secret) && this.#secrets.size >= this.#opts.maxSecrets) {
      throw new Error(`too many secrets (limit ${this.#opts.maxSecrets}): revoke some or wait for unclaimed ones to lapse`);
    }
    // Bind the secret and register the client's relays before the handler runs,
    // so a concurrent accept with the same secret is refused, and an auth_url
    // sent during approval goes to the client's relays rather than the host's.
    const record = this.#bind(parsed.secret, parsed.clientPubkey, parsed.relays, "secret already in use");
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
    this.#beginApproval(parsed.clientPubkey);
    try {
      await this.#runHandler(request, parsed.relays);
    } catch (err) {
      this.#endApproval(parsed.clientPubkey);
      this.#unbind(record, parsed.secret);
      // Whatever record the secret came from, a socket an auth_url opened to the scanned relays has no owner now.
      for (const url of parsed.relays) this.#closeSocket(url);
      throw err;
    }
    this.#endApproval(parsed.clientPubkey);
    if (this.#secrets.get(parsed.secret) !== record) {
      // Revoked while the user was deciding: the approval is discarded.
      record.pending -= 1;
      for (const url of parsed.relays) this.#closeSocket(url);
      throw new BunkerError("secret revoked");
    }
    record.pending -= 1;
    record.confirmed = true;
    record.relays = parsed.relays;
    delete record.expiresAt;
    await this.#admit(parsed.clientPubkey, parsed.secret, parsed.relays);
    this.#log.info?.("nostrconnect: client paired", { clientPubkey: parsed.clientPubkey, relays: parsed.relays });
    await this.#send(parsed.clientPubkey, { id: request.id, result: parsed.secret }, parsed.relays);
    return { ...parsed, requestId: request.id };
  }

  /** Listen on a host-chosen relay that was not in the initial set. Safe to call repeatedly. */
  addRelay(rawUrl: string): void {
    const url = normalizeRelays([rawUrl])[0]!;
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
    const urls = normalizeRelays([...this.#subs.keys(), ...this.#opened]);
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
    this.#opened.clear();
    if (this.#ownsPool) {
      this.#relayPool.getPool()?.close(urls);
      this.#relayPool.destroy();
    }
  }

  // ── Subscriptions ──

  /** Record `owner`'s interest in `url` without opening anything. */
  #claim(rawUrl: string, owner: string): RelaySubscription {
    const url = normalizeRelays([rawUrl])[0]!;
    let state = this.#subs.get(url);
    if (!state) {
      state = { closer: null, connecting: false, timer: null, failures: 0, owners: new Set() };
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
    this.#closeSocket(url);
    this.#log.debug?.("relay released", { relay: url });
  }

  /** Close a socket nothing subscribes on any more (owned pool only; an injected pool is the host's). */
  #closeSocket(url: string): void {
    if (this.#subs.has(url)) return;
    this.#opened.delete(url);
    if (this.#ownsPool) this.#relayPool.getPool()?.close([url]);
  }

  #subscribe(url: string, owner?: string): Promise<void> {
    const pool = this.#relayPool.getPool();
    if (!pool || this.#stopped) return Promise.resolve();
    const state = owner ? this.#claim(url, owner) : this.#subs.get(url);
    if (!state) return Promise.resolve();
    if (state.closer || state.connecting) return Promise.resolve();
    this.#opened.add(url);
    if (hasEnsureRelay(pool)) return this.#subscribeDirect(pool, url, state);
    // An injected pool without `ensureRelay` (something that is not nostr-tools) has to be
    // subscribed through its own API. Its deduplication then sits in front of ours; see
    // #subscribeDirect for what that means.
    this.#log.warn?.("pool has no ensureRelay; falling back to pool.subscribe and its own deduplication", { relay: url });
    return this.#subscribeViaPool(pool, url, state);
  }

  /**
   * One REQ per relay, opened on the relay connection itself rather than through
   * `pool.subscribe` / `subscribeMap`. This is deliberate and load-bearing.
   *
   * WHAT this avoids: the pool subscription's shared `_knownIds` deduplication.
   *
   * WHY it is unsafe here (nostr-tools 2.24.1): `abstract-relay.js:468` calls
   * `alreadyHaveEvent(id)` with the id lifted from the raw JSON text, and only
   * `:480` runs `matchFilters` and `verifyEvent`. The id is recorded as seen before
   * anything checks the event is genuine. An event carrying a real request's `id`
   * with a broken signature (no key needed, just the right 64 hex characters)
   * therefore makes the real request drop as a duplicate when it arrives.
   *
   * WHY our own callback cannot fix that through the pool: `abstract-pool.js:821-828`
   *
   *     const localAlreadyHaveEventHandler = (id) => {
   *       if (params.alreadyHaveEvent?.(id)) return true;
   *       const have = _knownIds.has(id);
   *       _knownIds.add(id);
   *       return have;
   *     };
   *
   * A caller's `alreadyHaveEvent` can only add suppression; returning `false`
   * still falls through to `_knownIds.add(id)`. `subscribeMap` installs the same
   * handler on every relay.
   *
   * WHY more relays do not help: that `_knownIds` is one set shared across every
   * relay in the subscription, so one hostile relay poisons it for all of them.
   *
   * WHAT this costs: the same genuine event arriving from three relays is parsed
   * and verified three times instead of once. That trade is right for this
   * package: NIP-46 traffic is a handful of events per session, `#onEvent`
   * verifies every event anyway, and the alternative is a silent channel for
   * suppressing signing requests. Do not "optimise" this back to `pool.subscribe`.
   *
   * WHEN this can go: if nostr-tools adds the id to its set only after
   * `verifyEvent` succeeds. Checked against 2.24.1; re-check those two files
   * before removing this.
   *
   * Connection management (connect, reconnect backoff, idle close, socket
   * lifecycle) stays with the pool through `ensureRelay`.
   */
  async #subscribeDirect(pool: RelayCapablePool, url: string, state: RelaySubscription): Promise<void> {
    state.connecting = true;
    let relay: RelayLike;
    try {
      relay = await pool.ensureRelay(url, { connectionTimeout: this.#opts.connectTimeoutMs });
    } catch (err) {
      state.connecting = false;
      this.#scheduleResubscribe(url, state, `connect failed: ${errorText(err)}`);
      return;
    }
    state.connecting = false;
    // Released or stopped while connecting: the socket is the pool's to keep or idle-close; open nothing.
    if (this.#stopped || this.#subs.get(url) !== state) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      let sub: { close(reason?: string): void } | null = null;
      const closer: SubCloser = { close: () => sub?.close() };
      sub = relay.subscribe([{ kinds: [NostrConnect], "#p": [this.#pubkey] }], {
        // Never suppress on an unverified id. `#seen` in #onEvent, after verification, is the only dedup.
        alreadyHaveEvent: () => false,
        onevent: (event) => {
          this.#onEvent(event, url);
        },
        oneose: () => {
          state.failures = 0;
          this.#log.debug?.("subscribed", { relay: url });
          settle();
        },
        onclose: (reason) => {
          if (state.closer === closer) state.closer = null;
          settle();
          this.#scheduleResubscribe(url, state, reason);
        },
      });
      state.closer = closer;
    });
  }

  /** Fallback for a pool that is not nostr-tools. See #subscribeDirect for why it is not the default. */
  #subscribeViaPool(pool: PoolLike, url: string, state: RelaySubscription): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      let closer: SubCloser | null = null;
      closer = pool.subscribe([url], { kinds: [NostrConnect], "#p": [this.#pubkey] }, {
        onevent: (event: NostrEvent) => {
          this.#onEvent(event, url);
        },
        oneose: () => {
          state.failures = 0;
          this.#log.debug?.("subscribed", { relay: url });
          settle();
        },
        onclose: (reasons: { url: string; reason: string }[]) => {
          if (state.closer === closer) state.closer = null;
          settle();
          this.#scheduleResubscribe(url, state, reasons.map((r) => r.reason).join("; "));
        },
      });
      state.closer = closer;
    });
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
    if (!verifyEvent(event as never)) {
      this.#log.warn?.("dropped request with invalid signature", { clientPubkey });
      return;
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
    if (skew > this.#opts.maxClockSkewSec) {
      this.#log.warn?.("dropped request outside the clock-skew limit", { clientPubkey, skewSec: skew });
      return;
    }
    // This is the ONLY deduplication in the path (see #subscribeDirect for why the
    // pool's is bypassed) and it must stay BELOW the signature and timestamp checks:
    // recording an unverified id here is exactly the suppression channel that
    // bypass exists to close. Keyed per sender, so one client cannot shadow another.
    if (this.#seen(clientPubkey, `e:${event.id}`)) return;

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
    const wasConnected = this.#clients.has(clientPubkey);
    // A client that logged out while this request was in flight has released
    // its relays; answering now would re-open one of them for nobody.
    const goneMeanwhile = () => wasConnected && !this.#clients.has(clientPubkey);
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
        result = await this.#runHandler(request, this.#clients.get(clientPubkey)?.relays ?? [sourceRelay]);
      }
    } catch (err) {
      const error = this.#wireError(err, request);
      this.#log.info?.("request refused", { clientPubkey, id: request.id, method: request.method, error });
      if (goneMeanwhile()) {
        this.#log.debug?.("response dropped: client left while the request was in flight", { clientPubkey, id: request.id });
        return;
      }
      await this.#send(clientPubkey, { id: request.id, error }, this.#clients.get(clientPubkey)?.relays ?? [sourceRelay]);
      return;
    }
    if (goneMeanwhile()) {
      this.#log.debug?.("response dropped: client left while the request was in flight", { clientPubkey, id: request.id });
      return;
    }
    await this.#send(clientPubkey, { id: request.id, result }, this.#clients.get(clientPubkey)?.relays ?? [sourceRelay]);
    // After the ack, not before: disconnecting first would release the client's
    // relays and then re-open one of them just to deliver this response.
    if (request.method === "logout") this.disconnectClient(clientPubkey);
  }

  async #connect(request: BunkerRequest, sourceRelay: string): Promise<string> {
    const secret = request.params[1] ?? "";
    const live = secret ? this.#liveSecret(secret) : undefined;
    if (this.#opts.requireSecret && !live) throw new BunkerError("invalid secret");
    if (this.#overClientCeiling(request.clientPubkey)) throw new BunkerError("too many clients");
    // Bind before the approval await, so a second client presenting the same
    // secret while this one is pending is refused rather than raced in. The
    // binding is refcounted: it is released only when the client's last pending
    // approval is rejected and none was ever confirmed.
    const record = live ? this.#bind(secret, request.clientPubkey, undefined, "secret already used by another client") : undefined;
    const responseRelays = record?.relays ?? [sourceRelay];
    this.#beginApproval(request.clientPubkey);
    try {
      await this.#runHandler(request, responseRelays);
    } catch (err) {
      this.#endApproval(request.clientPubkey);
      if (record) this.#unbind(record, secret);
      throw err;
    }
    this.#endApproval(request.clientPubkey);
    if (record) {
      if (this.#secrets.get(secret) !== record) {
        // Revoked while the user was deciding: the approval is discarded.
        record.pending -= 1;
        throw new BunkerError("secret revoked");
      }
      record.pending -= 1;
      record.confirmed = true;
      delete record.expiresAt;
    }
    await this.#admit(request.clientPubkey, secret || undefined, responseRelays);
    this.#log.info?.("client connected", { clientPubkey: request.clientPubkey });
    return "ack";
  }

  /**
   * Bind `secret` to `clientPubkey` (creating a `nostrconnect` record with
   * `relays` when none exists) and count one pending approval. Throws when the
   * secret is held by another client, pending or confirmed.
   */
  #bind(secret: string, clientPubkey: string, relays: string[] | undefined, refusal: string): SecretState {
    let record = this.#secrets.get(secret);
    if (record?.clientPubkey && record.clientPubkey !== clientPubkey) throw new BunkerError(refusal);
    if (!record) {
      if (!relays) throw new BunkerError("invalid secret");
      record = { relays, confirmed: false, pending: 0, origin: "nostrconnect" };
      this.#secrets.set(secret, record);
    }
    // An existing record's relays are untouched while approval is pending: a
    // rejected scan must leave no trace, and state never written needs no restoring.
    record.clientPubkey = clientPubkey;
    record.pending += 1;
    this.#emit();
    return record;
  }

  /** Undo one pending approval; free the secret when nothing else holds it. */
  #unbind(record: SecretState, secret: string): void {
    record.pending -= 1;
    if (record.pending <= 0 && !record.confirmed) {
      record.pending = 0;
      delete record.clientPubkey;
      // A record that only ever existed for this rejected nostrconnect pairing goes away entirely,
      // along with any socket an auth_url opened to the relays it named.
      if (record.origin === "nostrconnect" && this.#secrets.get(secret) === record) {
        this.#secrets.delete(secret);
        for (const url of record.relays) this.#closeSocket(url);
      }
      this.#emit();
    }
  }

  /** Mark a client connected, pinning its dedup window and its relay set. Resolves once its relays are subscribed. */
  async #admit(clientPubkey: string, secret: string | undefined, relays: string[], connectedAt = Date.now(), convKey?: Uint8Array): Promise<void> {
    const previous = this.#clients.get(clientPubkey);
    const relaySet = normalizeRelays(relays);
    const seen = previous?.seen ?? this.#strangers.get(clientPubkey) ?? new BoundedSet(this.#opts.seenCapacity);
    this.#strangers.delete(clientPubkey);
    this.#clients.set(clientPubkey, {
      connectedAt,
      ...(secret ? { secret } : {}),
      relays: relaySet,
      convKey: previous?.convKey ?? convKey ?? conversationKey(this.#sk, clientPubkey),
      seen,
    });
    if (previous) {
      for (const url of previous.relays) if (!relaySet.includes(url)) this.#release(url, clientPubkey);
    }
    this.#emit();
    if (this.#started && !this.#stopped) {
      await Promise.all(relaySet.map((url) => this.#subscribe(url, clientPubkey)));
    } else {
      for (const url of relaySet) this.#claim(url, clientPubkey);
    }
  }

  async #runHandler(request: BunkerRequest, responseRelays: string[]): Promise<string> {
    const context = this.#contextFor(request, responseRelays);
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

  /** `responseRelays` is where this request's client listens; it is handed in explicitly rather than looked up. */
  #contextFor(request: BunkerRequest, responseRelays: string[]): BunkerRequestContext {
    let authUrlSent = false;
    return {
      sendAuthUrl: async (url: string) => {
        if (authUrlSent) throw new Error("auth_url already sent for this request");
        authUrlSent = true;
        await this.#send(request.clientPubkey, { id: request.id, result: "auth_url", error: url }, responseRelays);
      },
    };
  }

  // ── Outbound ──

  async #send(clientPubkey: string, payload: ResponsePayload, relays: string[]): Promise<void> {
    if (this.#stopped) return;
    const event = buildResponseEvent(this.#sk, clientPubkey, this.#conversationKey(clientPubkey), payload);
    for (const url of relays) this.#opened.add(url);
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
