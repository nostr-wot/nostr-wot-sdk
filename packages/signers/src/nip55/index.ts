import type { Event, EventTemplate } from "nostr-tools";
import type { NostrSigner } from "../types";

/**
 * NIP-55 — Android external signer (Amber, Plebstr, etc).
 *
 * The signer app receives sign requests via Android `Intent`s; the
 * caller (a webview or a TWA) opens an intent URI and reads the result.
 *
 * Implementation detail: mobile Nostr clients deep-link to
 * `nostrsigner:<base64-payload>?type=sign_event&id=<request-id>`. The
 * signer responds via either intent results (native app) or a custom
 * URL scheme back to the caller. This SDK provides a thin browser shim
 * that opens the intent and waits for the response via postMessage,
 * URL hash, or a polling approach.
 *
 * Browser usage requires the page to be embedded in a TWA / Custom Tab
 * (so Android resolves `nostrsigner:` to Amber). Pure web pages can't
 * use NIP-55 — fall back to NIP-07 / NIP-46.
 *
 * Status: skeleton API; full bridge implementation is out of scope for
 * v0.1 since it requires either a native bridge or a TWA-aware
 * runtime. The signer shape exists so apps can wire UI today and the
 * underlying transport can be filled in later.
 */
export interface Nip55Bridge {
  /** Open a `nostrsigner:` intent and return the response payload. */
  request(intentUri: string, requestId: string): Promise<string>;
  /** Optional: returns true when running inside an environment that can
   *  resolve nostrsigner: intents (Amber installed, TWA active). */
  isAvailable?(): boolean;
}

export class Nip55Signer implements NostrSigner {
  readonly #bridge: Nip55Bridge;
  readonly #userPubkey: string;

  /**
   * `userPubkey` must already be known — Amber returns it during the
   * initial pairing. Pass it in from your app's auth store.
   */
  constructor(userPubkey: string, bridge: Nip55Bridge) {
    this.#userPubkey = userPubkey;
    this.#bridge = bridge;
  }

  async getPublicKey(): Promise<string> {
    return this.#userPubkey;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    const id = crypto.randomUUID();
    const payload = btoa(JSON.stringify({ ...template, pubkey: this.#userPubkey }));
    const intent = `nostrsigner:${payload}?type=sign_event&id=${encodeURIComponent(id)}`;
    const response = await this.#bridge.request(intent, id);
    return JSON.parse(response) as Event;
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#callIntent("nip04_encrypt", { pubkey: recipientPubkey, plaintext });
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#callIntent("nip04_decrypt", { pubkey: senderPubkey, ciphertext });
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.#callIntent("nip44_encrypt", { pubkey: recipientPubkey, plaintext });
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.#callIntent("nip44_decrypt", { pubkey: senderPubkey, ciphertext });
  }

  async #callIntent(type: string, params: Record<string, string>): Promise<string> {
    const id = crypto.randomUUID();
    const payload = btoa(JSON.stringify({ ...params, pubkey: this.#userPubkey }));
    const intent = `nostrsigner:${payload}?type=${type}&id=${encodeURIComponent(id)}`;
    return this.#bridge.request(intent, id);
  }
}
