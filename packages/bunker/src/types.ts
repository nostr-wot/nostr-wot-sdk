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
 */
export type BunkerHandler = (request: BunkerRequest, context: BunkerRequestContext) => Promise<string>;

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
  /** Delay before re-subscribing to a relay that dropped. Default 3000 ms; doubles per failure up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  /** Upper bound for the reconnect backoff. Default 60000 ms. */
  maxReconnectDelayMs?: number;
  /** Requests whose `created_at` is further than this from now are dropped. Default 300 s. */
  maxClockSkewSec?: number;
  /** How many recent request ids / event ids to remember for deduplication. Default 2048. */
  seenCapacity?: number;
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
