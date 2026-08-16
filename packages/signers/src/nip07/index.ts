import type { Event, EventTemplate } from "nostr-tools";
import type { NostrSigner } from "../types";

/**
 * NIP-07 — browser extension signer (Alby, nos2x, Flamingo, Nostore).
 * Reads / writes via `window.nostr` injected by the extension.
 *
 * Throws synchronously from the constructor if `window.nostr` isn't
 * available; UI code can catch + fall back to a different signer.
 */

export interface Nip07Window {
  nostr?: {
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
    nip04?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
    nip44?: {
      encrypt(
        pubkey: string,
        plaintext: string,
        opts?: { scheme: "pq"; recipientKemKey: string },
      ): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
    getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>;
  };
}

export function isNip07Available(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as Nip07Window).nostr);
}

export class Nip07Signer implements NostrSigner {
  readonly #ext: NonNullable<Nip07Window["nostr"]>;

  constructor() {
    if (typeof window === "undefined") {
      throw new Error("Nip07Signer requires a browser environment (window.nostr)");
    }
    const ext = (window as unknown as Nip07Window).nostr;
    if (!ext) {
      throw new Error("No NIP-07 extension detected. Install Alby, nos2x, or similar.");
    }
    this.#ext = ext;
  }

  async getPublicKey(): Promise<string> {
    return this.#ext.getPublicKey();
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return this.#ext.signEvent(template);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    if (!this.#ext.nip04) throw new Error("NIP-04 not supported by this extension");
    return this.#ext.nip04.encrypt(recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!this.#ext.nip04) throw new Error("NIP-04 not supported by this extension");
    return this.#ext.nip04.decrypt(senderPubkey, ciphertext);
  }

  async nip44Encrypt(
    recipientPubkey: string,
    plaintext: string,
    opts?: { scheme: "pq"; recipientKemKey: string },
  ): Promise<string> {
    if (!this.#ext.nip44) throw new Error("NIP-44 not supported by this extension");
    // Forward `opts` only when present, so extensions that predate post-quantum
    // support see the exact two-argument call they have always seen — a third
    // argument (even `undefined`) is observable to some implementations.
    return opts
      ? this.#ext.nip44.encrypt(recipientPubkey, plaintext, opts)
      : this.#ext.nip44.encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!this.#ext.nip44) throw new Error("NIP-44 not supported by this extension");
    return this.#ext.nip44.decrypt(senderPubkey, ciphertext);
  }

  /** Returns the extension's recommended relay set (NIP-07 optional API). */
  async getExtensionRelays(): Promise<
    Record<string, { read: boolean; write: boolean }> | null
  > {
    if (!this.#ext.getRelays) return null;
    try {
      return await this.#ext.getRelays();
    } catch {
      return null;
    }
  }
}
