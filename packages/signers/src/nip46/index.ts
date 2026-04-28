import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  SimplePool,
  type Event,
  type EventTemplate,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";
import type { NostrSigner } from "../types";

/**
 * NIP-46 — Nostr Connect remote signer (a.k.a. bunker).
 *
 * The signer's private key lives on a remote daemon ("bunker"). This
 * client communicates with it via encrypted DMs over relays. Used by
 * mobile apps + air-gapped key storage (Amber, Nsec.app, Nostrum, etc.).
 *
 * Two pairing modes:
 *
 *   - **bunker-initiated** (`bunker://`): the bunker generates the URI
 *     including its own pubkey + secret; user pastes/scans on the desktop.
 *     → `Nip46Signer.fromBunkerUri(uri, opts?)`
 *
 *   - **client-initiated** (`nostrconnect://`): the client (this signer)
 *     generates the URI and renders it as a QR; the bunker scans, then
 *     pings us with a `connect` request that includes the agreed secret.
 *     → `Nip46Signer.startNostrConnect(opts)` returns `{ uri, ready }` —
 *     render `uri` as a QR; `ready` resolves once the bunker pairs.
 *
 * The bunker may also respond to any request with `result: "auth_url"`
 * (and the URL in `error`), meaning "tell the user to approve at this
 * URL". Pass `onAuthChallenge` on construction to surface those prompts
 * to your UI; the signer keeps the request pending until the bunker
 * eventually responds with the real result or the request times out.
 */

export interface Nip46Options {
  /** Relays the bunker is listening on. */
  relays: string[];
  /** Optional client secret key. If absent, a fresh ephemeral key is
   *  generated. Persist the resulting nsec to keep the same client
   *  identity across page loads (the bunker remembers it for future
   *  authorizations). */
  clientSecretKey?: Uint8Array | string;
  /** Maximum time to wait for a single response from the bunker. */
  requestTimeoutMs?: number;
  /** Pool to use; defaults to a fresh internal pool. */
  pool?: SimplePool;
  /**
   * Called when the bunker responds to a request with `result: "auth_url"`.
   * The URL is what the bunker wants the user to visit to approve. The
   * pending request stays pending until the bunker responds with the
   * actual result OR the request times out — render the URL as a banner
   * so the user can click through.
   */
  onAuthChallenge?: (url: string) => void;
}

export interface NostrConnectOptions
  extends Omit<Nip46Options, "clientSecretKey"> {
  clientSecretKey?: Uint8Array | string;
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
  /** Cancel pairing. Resolves any in-flight `ready` with a rejection. */
  cancel: () => void;
  /** Resolves with the paired signer, or rejects on timeout/cancel. */
  ready: Promise<Nip46Signer>;
}

interface PendingRequest {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  authChallengeShown?: boolean;
}

export class Nip46Signer implements NostrSigner {
  readonly #relays: string[];
  readonly #clientSk: Uint8Array;
  readonly #clientPk: string;
  #bunkerPk: string;
  readonly #pool: SimplePool;
  readonly #requestTimeout: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #onAuthChallenge?: (url: string) => void;
  #userPk: string | null = null;
  #subClose: (() => void) | null = null;
  #ready: Promise<void>;
  /** When set, accept the first ANY-pubkey kind-24133 with our `#p` and
   *  lock onto its sender as `bunkerPk`. */
  #pendingNostrConnect: {
    secret: string;
    onPair: (bunkerPk: string) => void;
  } | null = null;

  private constructor(bunkerPk: string, opts: Nip46Options) {
    this.#bunkerPk = bunkerPk;
    this.#relays = opts.relays;
    this.#clientSk = opts.clientSecretKey
      ? typeof opts.clientSecretKey === "string"
        ? hexToBytes(opts.clientSecretKey)
        : opts.clientSecretKey
      : generateSecretKey();
    this.#clientPk = getPublicKey(this.#clientSk);
    this.#pool = opts.pool ?? new SimplePool();
    this.#requestTimeout = opts.requestTimeoutMs ?? 30_000;
    if (opts.onAuthChallenge) this.#onAuthChallenge = opts.onAuthChallenge;
    this.#ready = this.#openSubscription();
  }

  /**
   * Connect using a bunker URI (`bunker://<pubkey>?relay=...&secret=...`).
   *
   * The optional `secret` query param is sent as the first arg of the
   * `connect` call so the bunker can validate the pairing.
   */
  static async fromBunkerUri(uri: string, opts?: Partial<Nip46Options>): Promise<Nip46Signer> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "bunker:") {
      throw new Error(`Expected bunker:// URI, got ${parsed.protocol}`);
    }
    const bunkerPk = parsed.hostname;
    const relays = parsed.searchParams.getAll("relay");
    const secret = parsed.searchParams.get("secret") ?? "";
    if (relays.length === 0) {
      throw new Error("Bunker URI is missing at least one ?relay=wss://… parameter");
    }
    const merged: Nip46Options = {
      relays,
      ...(opts?.clientSecretKey !== undefined ? { clientSecretKey: opts.clientSecretKey } : {}),
      ...(opts?.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      ...(opts?.pool !== undefined ? { pool: opts.pool } : {}),
      ...(opts?.onAuthChallenge !== undefined ? { onAuthChallenge: opts.onAuthChallenge } : {}),
    };
    const signer = new Nip46Signer(bunkerPk, merged);
    await signer.#connectInitiator(secret);
    return signer;
  }

  /**
   * Start a `nostrconnect://` flow. Returns the URI to render as a QR,
   * plus a `ready` promise that resolves when the bunker pairs.
   */
  static startNostrConnect(opts: NostrConnectOptions): NostrConnectHandle {
    if (opts.relays.length === 0) {
      throw new Error("nostrconnect: at least one relay is required");
    }
    const baseOpts: Nip46Options = {
      relays: opts.relays,
      ...(opts.clientSecretKey !== undefined
        ? { clientSecretKey: opts.clientSecretKey }
        : {}),
      ...(opts.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: opts.requestTimeoutMs }
        : {}),
      ...(opts.pool !== undefined ? { pool: opts.pool } : {}),
      ...(opts.onAuthChallenge !== undefined
        ? { onAuthChallenge: opts.onAuthChallenge }
        : {}),
    };
    // bunkerPk is unknown until the bunker pings us; placeholder for now.
    const signer = new Nip46Signer("", baseOpts);

    const secret = opts.secret ?? randomSecret(16);
    const params = new URLSearchParams();
    for (const r of opts.relays) params.append("relay", r);
    params.set("secret", secret);
    if (opts.perms) params.set("perms", opts.perms);
    if (opts.metadata) {
      const meta: Record<string, string> = {};
      if (opts.metadata.name) meta.name = opts.metadata.name;
      if (opts.metadata.url) meta.url = opts.metadata.url;
      if (opts.metadata.description) meta.description = opts.metadata.description;
      if (opts.metadata.image) meta.image = opts.metadata.image;
      if (Object.keys(meta).length > 0) {
        params.set("metadata", JSON.stringify(meta));
      }
    }
    if (opts.metadata?.name && !params.has("name")) params.set("name", opts.metadata.name);

    const uri = `nostrconnect://${signer.#clientPk}?${params.toString()}`;
    const pairTimeout = opts.pairTimeoutMs ?? 5 * 60_000;

    let cancelled = false;
    const ready = new Promise<Nip46Signer>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelled = true;
        signer.#pendingNostrConnect = null;
        void signer.close();
        reject(new Error("nostrconnect: pairing timed out"));
      }, pairTimeout);

      signer.#pendingNostrConnect = {
        secret,
        onPair: (bunkerPk) => {
          if (cancelled) return;
          clearTimeout(timer);
          signer.#bunkerPk = bunkerPk;
          signer.#pendingNostrConnect = null;
          resolve(signer);
        },
      };
    });

    return {
      uri,
      clientPubkey: signer.#clientPk,
      cancel: () => {
        cancelled = true;
        signer.#pendingNostrConnect = null;
        void signer.close();
      },
      ready,
    };
  }

  async getPublicKey(): Promise<string> {
    if (!this.#userPk) {
      const result = await this.#request("get_public_key", []);
      this.#userPk = result;
    }
    return this.#userPk;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    const userPk = await this.getPublicKey();
    const unsigned = { ...template, pubkey: userPk } as EventTemplate & { pubkey: string };
    const result = await this.#request("sign_event", [JSON.stringify(unsigned)]);
    return JSON.parse(result) as Event;
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#request("nip04_encrypt", [recipientPubkey, plaintext]);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#request("nip04_decrypt", [senderPubkey, ciphertext]);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#request("nip44_encrypt", [recipientPubkey, plaintext]);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#request("nip44_decrypt", [senderPubkey, ciphertext]);
  }

  /** Persist the client key (nsec) so future sessions reuse the same
   *  client identity (bunker remembers paired clients). */
  exportClientNsec(): string {
    return nip19.nsecEncode(this.#clientSk);
  }

  /** The bunker's pubkey, once paired. Used by the UI to persist the
   *  pairing for silent restore. */
  get bunkerPubkey(): string {
    return this.#bunkerPk;
  }

  /** The relays this signer talks to the bunker over. */
  get relays(): string[] {
    return [...this.#relays];
  }

  async close(): Promise<void> {
    this.#subClose?.();
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Signer closed"));
    }
    this.#pending.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  async #openSubscription(): Promise<void> {
    const sub = this.#pool.subscribeMany(
      this.#relays,
      { kinds: [24133], "#p": [this.#clientPk] },
      {
        onevent: (event: Event) => void this.#onMessage(event),
        oneose: () => undefined,
      },
    );
    this.#subClose = () => {
      try {
        sub.close();
      } catch {
        /* noop */
      }
    };
  }

  /** Send the initial `connect` call after pasting a bunker URI. */
  async #connectInitiator(secret: string): Promise<void> {
    await this.#ready;
    const args = secret ? [this.#bunkerPk, secret] : [this.#bunkerPk];
    await this.#request("connect", args);
  }

  async #request(method: string, params: string[]): Promise<string> {
    await this.#ready;
    if (!this.#bunkerPk) {
      throw new Error("NIP-46 signer is not paired yet (no bunker pubkey)");
    }
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, method, params });
    const conv = nip44.v2.utils.getConversationKey(this.#clientSk, this.#bunkerPk);
    const ciphertext = nip44.v2.encrypt(payload, conv);

    const reqEvent = finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.#bunkerPk]],
        content: ciphertext,
      },
      this.#clientSk,
    );

    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`NIP-46 ${method} request timed out after ${this.#requestTimeout}ms`));
      }, this.#requestTimeout);
      this.#pending.set(id, { resolve, reject, timer });
    });

    await Promise.allSettled(this.#pool.publish(this.#relays, reqEvent));
    return promise;
  }

  async #onMessage(event: Event): Promise<void> {
    // Pending nostrconnect: any sender is a candidate; verify by decrypting
    // the inner connect request and matching the secret.
    if (this.#pendingNostrConnect) {
      try {
        const conv = nip44.v2.utils.getConversationKey(this.#clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload) as {
          id?: string;
          method?: string;
          params?: string[];
        };
        // The bunker sends a `connect` request with the secret as a param.
        // Accept the first match; everything else through this path is
        // ignored (a confused or malicious sender just won't pair).
        if (parsed.method === "connect" && parsed.params) {
          const matched = parsed.params.includes(this.#pendingNostrConnect.secret);
          if (matched) {
            const bunkerPk = event.pubkey;
            this.#pendingNostrConnect.onPair(bunkerPk);
            // Reply with "ack" so the bunker knows we accepted.
            if (parsed.id) await this.#sendAck(bunkerPk, parsed.id);
            return;
          }
        }
      } catch {
        /* not for us */
      }
      return;
    }

    if (!this.#bunkerPk || event.pubkey !== this.#bunkerPk) return;
    let payload: string;
    try {
      const conv = nip44.v2.utils.getConversationKey(this.#clientSk, this.#bunkerPk);
      payload = nip44.v2.decrypt(event.content, conv);
    } catch {
      return;
    }
    let parsed: { id?: string; result?: string; error?: string };
    try {
      parsed = JSON.parse(payload) as { id?: string; result?: string; error?: string };
    } catch {
      return;
    }
    if (!parsed.id) return;
    const pending = this.#pending.get(parsed.id);
    if (!pending) return;

    // "auth_url" challenge: the bunker wants the user to approve at a URL.
    // Surface to the consumer; keep the request pending until the bunker
    // sends a real response or we time out.
    if (parsed.result === "auth_url" && parsed.error && !pending.authChallengeShown) {
      pending.authChallengeShown = true;
      try {
        this.#onAuthChallenge?.(parsed.error);
      } catch {
        /* user callback errors don't kill the flow */
      }
      return;
    }

    this.#pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error) {
      pending.reject(new Error(parsed.error));
    } else {
      pending.resolve(parsed.result ?? "");
    }
  }

  async #sendAck(bunkerPk: string, id: string): Promise<void> {
    const payload = JSON.stringify({ id, result: "ack" });
    const conv = nip44.v2.utils.getConversationKey(this.#clientSk, bunkerPk);
    const ciphertext = nip44.v2.encrypt(payload, conv);
    const reqEvent = finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bunkerPk]],
        content: ciphertext,
      },
      this.#clientSk,
    );
    await Promise.allSettled(this.#pool.publish(this.#relays, reqEvent));
  }
}

function randomSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}
