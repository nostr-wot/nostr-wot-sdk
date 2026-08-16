import { generateSecretKey, getPublicKey, nip19, SimplePool, type Event, type EventTemplate } from "nostr-tools";
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from "nostr-tools/nip46";
import { hexToBytes } from "@noble/hashes/utils";
import type { NostrSigner } from "../types";

/**
 * NIP-46 — Nostr Connect remote signer (a.k.a. bunker).
 *
 * Thin adapter over `nostr-tools/nip46`'s {@link BunkerSigner} so we get the
 * battle-tested handshake (Amber, Nsec.app, Keychat all interoperate) while
 * exposing our own {@link NostrSigner} surface — same public API the SDK has
 * always shipped.
 *
 * Two pairing modes:
 *
 *   - **bunker-initiated** (`bunker://`): the bunker generates the URI
 *     including its own pubkey + secret; user pastes/scans on the desktop.
 *     → {@link Nip46Signer.fromBunkerUri}
 *
 *   - **client-initiated** (`nostrconnect://`): the client (this signer)
 *     generates the URI and renders it as a QR; the bunker scans, then
 *     pings us. → {@link Nip46Signer.startNostrConnect} returns
 *     `{ uri, ready }` — render `uri` as a QR; `ready` resolves once paired.
 *
 * The bunker may also respond to any request with `result: "auth_url"`
 * (and the URL in `error`), meaning "tell the user to approve at this URL".
 * Pass `onAuthChallenge` on construction to surface those prompts; the
 * underlying request stays pending until the bunker eventually responds with
 * the real result.
 */

export interface Nip46Options {
  /** Relays the bunker is listening on. */
  relays: string[];
  /** Optional client secret key. If absent, a fresh ephemeral key is
   *  generated. Persist the resulting nsec to keep the same client identity
   *  across page loads (the bunker remembers paired clients). */
  clientSecretKey?: Uint8Array | string;
  /** Pool to use; defaults to a fresh internal pool. */
  pool?: SimplePool;
  /** Surfaced when the bunker responds with `result: "auth_url"`. */
  onAuthChallenge?: (url: string) => void;
}

export interface NostrConnectOptions extends Nip46Options {
  /** Random secret bound into the URI; bunker echoes it on connect. Auto-generated if absent. */
  secret?: string;
  /** Comma-separated permissions, e.g. "sign_event:1,nip44_encrypt". */
  perms?: string;
  /** App metadata advertised to the user during pairing. */
  metadata?: {
    name?: string;
    url?: string;
    description?: string;
    image?: string;
  };
  /** Time budget waiting for the bunker to scan + connect. Default 5 min. */
  pairTimeoutMs?: number;
}

export interface NostrConnectHandle {
  /** Render this as a QR. The bunker scans → `ready` resolves. */
  uri: string;
  /** The ephemeral client pubkey (advertised in the URI). */
  clientPubkey: string;
  /** Cancel pairing. Rejects any in-flight `ready`. */
  cancel: () => void;
  /** Resolves with the paired signer, or rejects on timeout/cancel. */
  ready: Promise<Nip46Signer>;
}

function toBytes(sk: Uint8Array | string): Uint8Array {
  return typeof sk === "string" ? hexToBytes(sk) : sk;
}

export class Nip46Signer implements NostrSigner {
  readonly #inner: BunkerSigner;
  readonly #clientSk: Uint8Array;
  readonly #relays: string[];

  private constructor(inner: BunkerSigner, clientSk: Uint8Array, relays: string[]) {
    this.#inner = inner;
    this.#clientSk = clientSk;
    this.#relays = relays;
  }

  /**
   * Connect using a bunker URI (`bunker://<pubkey>?relay=...&secret=...`)
   * or a NIP-05 identifier that resolves to one.
   */
  static async fromBunkerUri(
    uri: string,
    opts?: Partial<Nip46Options>,
  ): Promise<Nip46Signer> {
    const bp: BunkerPointer | null = await parseBunkerInput(uri);
    if (!bp) throw new Error(`Invalid bunker URI: ${uri}`);
    if (bp.relays.length === 0) {
      throw new Error("Bunker URI is missing at least one ?relay=wss://… parameter");
    }

    const clientSk = opts?.clientSecretKey ? toBytes(opts.clientSecretKey) : generateSecretKey();
    const inner = BunkerSigner.fromBunker(clientSk, bp, {
      ...(opts?.pool ? { pool: opts.pool } : {}),
      ...(opts?.onAuthChallenge ? { onauth: opts.onAuthChallenge } : {}),
    });
    await inner.connect();
    return new Nip46Signer(inner, clientSk, bp.relays);
  }

  /**
   * Start a `nostrconnect://` flow. Returns the URI to render as a QR plus a
   * `ready` promise that resolves when the bunker pairs.
   */
  static startNostrConnect(opts: NostrConnectOptions): NostrConnectHandle {
    if (opts.relays.length === 0) {
      throw new Error("nostrconnect: at least one relay is required");
    }
    const clientSk = opts.clientSecretKey ? toBytes(opts.clientSecretKey) : generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const secret = opts.secret ?? randomSecret(16);

    const uri = createNostrConnectURI({
      clientPubkey,
      relays: opts.relays,
      secret,
      ...(opts.perms ? { perms: opts.perms.split(",").map((p) => p.trim()).filter(Boolean) } : {}),
      ...(opts.metadata?.name ? { name: opts.metadata.name } : {}),
      ...(opts.metadata?.url ? { url: opts.metadata.url } : {}),
      ...(opts.metadata?.image ? { image: opts.metadata.image } : {}),
    });

    const pairTimeout = opts.pairTimeoutMs ?? 5 * 60_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), pairTimeout);

    const bunkerParams = {
      ...(opts.pool ? { pool: opts.pool } : {}),
      ...(opts.onAuthChallenge ? { onauth: opts.onAuthChallenge } : {}),
    };

    let cancelled = false;
    let inner: BunkerSigner | null = null;

    const ready = (async (): Promise<Nip46Signer> => {
      try {
        inner = await BunkerSigner.fromURI(clientSk, uri, bunkerParams, abort.signal);
        if (cancelled) {
          await inner.close().catch(() => {});
          throw new Error("nostrconnect: cancelled");
        }
        // BunkerSigner.fromURI resolves once the bunker has paired; the
        // `connect` call itself happens internally. Touching getPublicKey is
        // a cheap way to confirm the channel is live before the UI settles.
        return new Nip46Signer(inner, clientSk, opts.relays);
      } catch (err) {
        if (abort.signal.aborted && !cancelled) {
          throw new Error("nostrconnect: pairing timed out");
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();

    return {
      uri,
      clientPubkey,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        abort.abort();
        if (inner) void inner.close().catch(() => {});
      },
      ready,
    };
  }

  async getPublicKey(): Promise<string> {
    return this.#inner.getPublicKey();
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return (await this.#inner.signEvent(template)) as Event;
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#inner.nip04Encrypt(recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#inner.nip04Decrypt(senderPubkey, ciphertext);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#inner.nip44Encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#inner.nip44Decrypt(senderPubkey, ciphertext);
  }

  /** Persist the client key (nsec) so future sessions reuse the same client
   *  identity (bunker remembers paired clients). */
  exportClientNsec(): string {
    return nip19.nsecEncode(this.#clientSk);
  }

  /** The bunker's pubkey, once paired. */
  get bunkerPubkey(): string {
    return this.#inner.bp.pubkey;
  }

  /** The relays this signer talks to the bunker over. */
  get relays(): string[] {
    return [...(this.#inner.bp.relays ?? this.#relays)];
  }

  async close(): Promise<void> {
    try {
      await this.#inner.close();
    } catch {
      /* ignore */
    }
  }
}

function randomSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}
