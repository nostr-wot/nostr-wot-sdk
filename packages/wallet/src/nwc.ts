import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  SimplePool,
  type Event,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";

/**
 * Nostr Wallet Connect (NIP-47).
 *
 * The wallet daemon advertises a connection URI that includes:
 *   - `nostrwalletconnect://<wallet-pubkey>?relay=...&secret=...`
 *
 * The client encrypts kind 23194 requests via NIP-04 to the wallet
 * pubkey, publishes them to the wallet's relay, and waits for the
 * matching kind 23195 response.
 *
 * This client supports the standard NWC methods: `pay_invoice`,
 * `make_invoice`, `lookup_invoice`, `list_transactions`, `get_balance`,
 * `get_info`. Custom methods can be invoked via `call(method, params)`.
 */

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

export interface NWCConnection {
  walletPubkey: string;
  relay: string;
  clientSecretKey: Uint8Array;
}

export function parseNwcUri(uri: string): NWCConnection {
  const url = new URL(uri.replace(/^nostr\+walletconnect:/, "nostrwalletconnect:"));
  if (url.protocol !== "nostrwalletconnect:") {
    throw new Error(`Expected nostrwalletconnect: URI, got ${url.protocol}`);
  }
  const walletPubkey = url.hostname || url.pathname.replace(/^\/\//, "").split("?")[0]!;
  const relay = url.searchParams.get("relay");
  const secret = url.searchParams.get("secret");
  if (!walletPubkey) throw new Error("NWC URI missing wallet pubkey");
  if (!relay) throw new Error("NWC URI missing relay parameter");
  if (!secret) throw new Error("NWC URI missing secret parameter");
  return {
    walletPubkey,
    relay,
    clientSecretKey: hexToBytes(secret),
  };
}

export type NwcResult<T = unknown> = { result: T; result_type: string } | { error: { code: string; message: string } };

export class NwcClient {
  readonly #conn: NWCConnection;
  readonly #pool: SimplePool;
  readonly #clientPk: string;

  constructor(connection: NWCConnection, pool?: SimplePool) {
    this.#conn = connection;
    this.#pool = pool ?? new SimplePool();
    this.#clientPk = getPublicKey(connection.clientSecretKey);
  }

  static fromUri(uri: string, pool?: SimplePool): NwcClient {
    return new NwcClient(parseNwcUri(uri), pool);
  }

  async payInvoice(invoice: string): Promise<{ preimage: string; fees_paid?: number }> {
    return this.call("pay_invoice", { invoice });
  }

  async makeInvoice(amountSats: number, description?: string): Promise<{ invoice: string; payment_hash: string }> {
    return this.call("make_invoice", {
      amount: amountSats * 1000, // msats
      description: description ?? "",
    });
  }

  async getBalance(): Promise<{ balance: number }> {
    return this.call("get_balance", {});
  }

  async getInfo(): Promise<{
    alias: string;
    color: string;
    pubkey: string;
    network: string;
    block_height: number;
    methods: string[];
  }> {
    return this.call("get_info", {});
  }

  async lookupInvoice(payment_hash: string): Promise<{
    invoice?: string;
    settled?: boolean;
    settled_at?: number;
    amount?: number;
  }> {
    return this.call("lookup_invoice", { payment_hash });
  }

  /**
   * Generic call. Returns the wallet's `result` payload or throws an
   * Error with `code` and `message` from the wallet on failure.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ method, params });
    const ciphertext = await nip04.encrypt(
      this.#conn.clientSecretKey,
      this.#conn.walletPubkey,
      payload,
    );
    const reqEvent = finalizeEvent(
      {
        kind: NWC_REQUEST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.#conn.walletPubkey]],
        content: ciphertext,
      },
      this.#conn.clientSecretKey,
    );

    const responsePromise = this.#waitForResponse(reqEvent.id);
    await Promise.allSettled(this.#pool.publish([this.#conn.relay], reqEvent));
    const response = await responsePromise;

    const decrypted = await nip04.decrypt(
      this.#conn.clientSecretKey,
      this.#conn.walletPubkey,
      response.content,
    );
    const parsed = JSON.parse(decrypted) as NwcResult<T>;
    if ("error" in parsed) {
      throw new Error(`NWC ${method}: ${parsed.error.code} — ${parsed.error.message}`);
    }
    return parsed.result;
  }

  #waitForResponse(requestId: string): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          sub.close();
        } catch {
          /* noop */
        }
        reject(new Error(`NWC request ${requestId.slice(0, 8)}… timed out`));
      }, 30_000);

      const sub = this.#pool.subscribeMany(
        [this.#conn.relay],
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [this.#conn.walletPubkey],
          "#p": [this.#clientPk],
          "#e": [requestId],
        },
        {
          onevent: (event: Event) => {
            clearTimeout(timeout);
            try {
              sub.close();
            } catch {
              /* noop */
            }
            resolve(event);
          },
          oneose: () => undefined,
        },
      );
    });
  }
}
