import type { PoolLike } from "@nostr-wot/relay";

/** A decrypted NIP-46 request, exactly as the client sent it. */
export interface BunkerRequest {
  /** NIP-46 request id. Every response carries it back unchanged. */
  id: string;
  /** The remote client's public key (the caller's identity, never the user's). */
  clientPubkey: string;
  /** `connect` | `get_public_key` | `sign_event` | `nip04_encrypt` | ... */
  method: string;
  /** NIP-46 params, raw. Non-string params are JSON-stringified before reaching the handler. */
  params: string[];
}

/** Per-request facilities the transport offers the handler. */
export interface BunkerRequestContext {
  /**
   * Send an interim `auth_url` response for this request (`result: "auth_url"`,
   * `error: <url>`), so the client can open a page where the user approves.
   * The promise the handler eventually returns still delivers the real result on
   * the same request id. Only one `auth_url` may be sent per request: a second
   * one is refused, because clients treat a repeated `auth_url` as an error.
   */
  sendAuthUrl(url: string): Promise<void>;
}

/**
 * Resolves with the NIP-46 `result` string, or rejects; a rejection becomes an
 * `error` response. The second argument is optional: a one-argument function is
 * a valid handler.
 *
 * What the remote client sees on rejection is decided by `mapError`
 * (see {@link BunkerServerOptions.mapError}). By default only a
 * {@link BunkerError}'s message crosses the wire; any other throw is reduced
 * to `"request rejected"`, so a vault, keychain or parser exception never
 * leaves the device. Throw `BunkerError` for text the caller should read.
 */
export type BunkerHandler = (request: BunkerRequest, context: BunkerRequestContext) => Promise<string>;

/**
 * Maps a handler rejection to the `error` string sent to the client. Return
 * text you are happy for a remote party to read.
 */
export type BunkerErrorMapper = (error: unknown, request: BunkerRequest) => string;

/**
 * Optional logger. Nothing secret ever reaches it: no keys, no plaintext, no
 * ciphertext. Metadata is limited to method names, request ids, client pubkeys
 * and relay URLs.
 */
export interface BunkerLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface BunkerServerOptions {
  /**
   * The remote-signer (transport) secret key: 32 bytes or 64-char hex. It signs
   * and encrypts every NIP-46 message. It is deliberately NOT the user's identity
   * key; `get_public_key` is answered by the handler, which is where the user
   * key lives.
   */
  connectionSecretKey: Uint8Array | string;
  /** Relays to listen on. Responses are published to every relay in the set. */
  relays: string[];
  /** Everything policy-related. See {@link BunkerHandler}. */
  handler: BunkerHandler;
  /** Inject an existing pool (anything `SimplePool`-shaped). Its connections are left open on `stop()`. */
  pool?: PoolLike;
  /**
   * WebSocket constructor for environments whose global differs (React Native).
   * Installed process-wide through nostr-tools' `useWebSocketImplementation`,
   * the same way `@nostr-wot/graph` does it. Ignored when `pool` is injected.
   */
  websocketImplementation?: unknown;
  logger?: BunkerLogger;
  /**
   * Require every `connect` to carry a pairing secret issued by
   * {@link BunkerServer.createBunkerUri} or accepted via
   * {@link BunkerServer.acceptNostrConnect}. Default `true`. With `false`,
   * `connect` is still forwarded to the handler, which then owns admission entirely.
   */
  requireSecret?: boolean;
  /**
   * Turns a handler rejection into the wire-visible `error` string. The
   * default forwards a {@link BunkerError}'s message and replaces everything
   * else with `"request rejected"`.
   */
  mapError?: BunkerErrorMapper;
  /**
   * A handler that has not settled after this long is answered with
   * `error: "request timed out"` and its eventual result is discarded.
   * Default 120000 ms. `0` disables the limit.
   */
  handlerTimeoutMs?: number;
  /**
   * How long a relay may take to connect before the attempt counts as failed.
   * Default 3000 ms.
   *
   * Caveat (nostr-tools 2.24.1): when this timeout fires, `AbstractRelay.connect`
   * nulls the socket's handlers without closing the socket, and the pool drops the
   * relay from its map, so the still-connecting socket is orphaned and `stop()`
   * cannot reach it. Against a relay that takes longer than this to accept, every
   * attempt (including each backoff retry) leaks one socket for the process
   * lifetime. Set it generously on long-running hosts, and prefer relays that
   * accept quickly. Tracked as an upstream defect; see the package report.
   */
  connectTimeoutMs?: number;
  /** Delay before re-subscribing to a relay that dropped. Default 3000 ms; doubles per failure up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  /** Upper bound for the reconnect backoff. Default 60000 ms. */
  maxReconnectDelayMs?: number;
  /** Requests whose `created_at` is further than this from now are dropped. Default 300 s. */
  maxClockSkewSec?: number;
  /**
   * Unclaimed pairing secrets lapse this long after minting. Default 900000 ms
   * (15 minutes); `0` disables. A secret whose `connect` was approved never
   * expires: paired clients reconnect with it for as long as the host keeps it.
   * `createBunkerUri({ ttlMs })` overrides it per mint.
   */
  secretTtlMs?: number;
  /**
   * Called with a fresh {@link BunkerState} every time something a host would
   * persist changes: a secret minted, bound, confirmed, released, revoked or
   * lapsed; a client admitted or forgotten. Hand the latest one back to
   * {@link BunkerServer.restore} after a restart.
   */
  onStateChange?: (state: BunkerState) => void;
  /** Recent request ids and event ids remembered per client for deduplication. Default 256. */
  seenCapacity?: number;
  /** How many not-yet-connected senders keep a deduplication window at once. Default 256. */
  strangerCapacity?: number;
}

/**
 * One pairing secret as a host persists it. `clientPubkey` is the client it is
 * bound to; `confirmed` says the handler approved that client's `connect`.
 * A restored bound secret refuses every other client, across restarts.
 */
export interface BunkerSecretRecord {
  secret: string;
  /** Who minted it: the host (`createBunkerUri`) or a client's `nostrconnect://` URI. */
  origin: "bunker" | "nostrconnect";
  /** Where the client paired with this secret is answered. */
  relays: string[];
  clientPubkey?: string;
  confirmed: boolean;
  /** Unix ms. Only an unconfirmed secret lapses; absent means never. */
  expiresAt?: number;
}

/** One paired client as a host persists it. */
export interface BunkerClientRecord {
  clientPubkey: string;
  /** Its own relay set: where its responses go, and nowhere else. */
  relays: string[];
  secret?: string;
  /** Unix ms. */
  connectedAt: number;
}

/**
 * Everything a host must persist for paired clients to survive a restart:
 * hand it to {@link BunkerServer.restore} on the way back up, with the same
 * connection key. Secrets carry their bindings, clients carry their relays.
 * Pending approvals are exported as bound but unconfirmed: the same client may
 * retry, another is refused.
 */
export interface BunkerState {
  secrets: BunkerSecretRecord[];
  clients: BunkerClientRecord[];
}

/**
 * An error whose message is meant for the remote client. The default
 * `mapError` forwards it verbatim; every other throw is replaced with
 * `"request rejected"`. Detected by the `wireVisible` marker rather than
 * `instanceof`, so a copy of this class bundled elsewhere still counts.
 */
export class BunkerError extends Error {
  readonly wireVisible = true as const;
  constructor(message: string) {
    super(message);
    this.name = "BunkerError";
  }
}

/** What {@link BunkerServer.createBunkerUri} returns. */
export interface BunkerUri {
  /** `bunker://<connection-pubkey>?relay=...&secret=...`: hand this to the client. */
  uri: string;
  /** The pairing secret bound into the URI. */
  secret: string;
}

/** The parsed contents of a `nostrconnect://` URI. */
export interface NostrConnectUri {
  clientPubkey: string;
  relays: string[];
  secret: string;
  perms: string[];
  name?: string;
  url?: string;
  image?: string;
}

/** What {@link BunkerServer.acceptNostrConnect} returns once the client is paired. */
export interface NostrConnectPairing extends NostrConnectUri {
  /** The id of the synthetic `connect` request the handler approved. */
  requestId: string;
}
