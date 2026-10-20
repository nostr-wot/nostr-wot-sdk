import type { Event, EventTemplate } from "nostr-tools";

/**
 * Common interface every signer implements. Designed to be a thin layer
 * over nostr-tools — `signEvent` returns a fully-formed signed Event,
 * matching `nostr-tools/finalizeEvent` output shape.
 */
export interface NostrSigner {
  /** Returns the signer's hex pubkey. */
  getPublicKey(): Promise<string>;

  /** Sign an event template, returning a finalized Event. */
  signEvent(template: EventTemplate): Promise<Event>;

  /** NIP-04 encrypt to `recipientPubkey`. Optional — not all signers
   *  support this. Throws if unsupported. */
  nip04Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;

  /**
   * NIP-44 v2 encryption. Optional — modern preferred path.
   *
   * `opts` requests post-quantum sealing (`@nostr-wot/pq`'s hybrid ML-KEM-1024 +
   * NIP-44 envelope) instead of plain NIP-44 ciphertext. Key material never leaves
   * the signer: the caller supplies only the recipient's public ML-KEM key (base64,
   * from their kind:10203 attestation); the signer derives the conversation key and
   * performs the hybrid encryption internally, exactly as it already does for plain
   * NIP-44. A signer that doesn't implement post-quantum sealing should throw if
   * `opts` is given rather than silently falling back to plain NIP-44 — a silent
   * downgrade of a message the caller explicitly asked to protect post-quantum is
   * worse than a loud failure.
   */
  nip44Encrypt?(
    recipientPubkey: string,
    plaintext: string,
    opts?: { scheme: "pq"; recipientKemKey: string },
  ): Promise<string>;
  /**
   * NIP-44 v2 decryption. Auto-routes: post-quantum ciphertext is self-describing
   * (`@nostr-wot/pq`'s `isPqEnvelope`), so the signer detects it and decrypts
   * accordingly with no flag from the caller. A signer that cannot decrypt a
   * post-quantum payload (missing ML-KEM secret key, or no post-quantum support at
   * all) throws.
   */
  nip44Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;

  /** Optional disposal hook — for signers that hold a connection
   *  (NIP-46) or extension permission. */
  close?(): Promise<void> | void;
}
