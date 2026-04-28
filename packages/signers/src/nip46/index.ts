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
 * Bootstrap flows supported:
 *   - `bunker://<bunker-pubkey>?relay=wss://...&secret=...`
 *     (paste a connection URI from your remote signer)
 *   - `nostrconnect://<client-pubkey>?relay=...&perms=...`
 *     (NIP-46 client-initiated; not implemented in v0 — use bunker URI)
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
  /** Pool to use; defaults to the SDK's shared pool. */
  pool?: SimplePool;
}

interface PendingRequest {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Nip46Signer implements NostrSigner {
  readonly #relays: string[];
  readonly #clientSk: Uint8Array;
  readonly #clientPk: string;
  readonly #bunkerPk: string;
  readonly #pool: SimplePool;
  readonly #requestTimeout: number;
  readonly #pending = new Map<string, PendingRequest>();
  #userPk: string | null = null;
  #subClose: (() => void) | null = null;
  #ready: Promise<void>;

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
    };
    const signer = new Nip46Signer(bunkerPk, merged);
    await signer.#connect(secret);
    return signer;
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
    // Listen for kind 24133 events targeted at our client pubkey
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

  async #connect(secret: string): Promise<void> {
    await this.#ready;
    // The connect call's first arg per NIP-46 is the bunker pubkey echoed
    // back, then optional secret. Implementations vary; we send both.
    const args = secret ? [this.#bunkerPk, secret] : [this.#bunkerPk];
    const result = await this.#request("connect", args);
    if (result !== "ack" && result !== "" && result !== this.#bunkerPk) {
      // Some bunkers return "ack", some return their pubkey, some empty.
      // Treat any non-error response as success.
    }
  }

  async #request(method: string, params: string[]): Promise<string> {
    await this.#ready;
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
    if (event.pubkey !== this.#bunkerPk) return;
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
    this.#pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error) {
      pending.reject(new Error(parsed.error));
    } else {
      pending.resolve(parsed.result ?? "");
    }
  }
}
