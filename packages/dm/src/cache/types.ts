import type { Event as NostrEvent, UnsignedEvent } from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";

export type DMMessage = {
  /** Source event id (kind 4 for NIP-04, kind 14 inner for NIP-17). */
  id: string;
  /** "self" or partner pubkey — who sent this message. */
  fromPubkey: string;
  /** Always the partner. For self-sent messages this is the recipient. */
  partnerPubkey: string;
  /** Decrypted plaintext. */
  content: string;
  /** Unix seconds. For NIP-17, the inner event's created_at (NOT the
   *  randomized wrap timestamp). */
  createdAt: number;
  /** Standard the message was carried over. */
  scheme: "nip04" | "nip17";
  /** The original on-the-wire event (for re-decrypt / debugging). Not
   *  persisted by default — strip before serialising to avoid leaking
   *  metadata. */
  raw?: NostrEvent;
};

export type DMConversation = {
  partnerPubkey: string;
  /** Most recent message timestamp (Unix sec). 0 if no messages yet. */
  lastMessageAt: number;
  /** Quick-render preview — first 80 chars of the most recent message. */
  preview: string;
  /** Total messages cached locally for this partner. */
  messageCount: number;
};

export interface DMSession {
  /** The logged-in user's hex pubkey. */
  myPubkey: string;
  /** Signer used for outbound encryption + inbound decryption. */
  signer: NostrSigner;
  /** Relays to publish to + subscribe on. */
  relays: string[];
  /** Optional persistence backend; in-memory only if absent. */
  storage?: DMStorage;
  /** Auto-discover the user's NIP-17 inbox relays (kind 10050). */
  discoverInboxRelays?: boolean;
  /** Internal: teardown for auto-persist subscription. Set by initDMSession. */
  _autoPersistOff?: () => void;
}

/**
 * Optional persistence layer. The default in-memory cache lives only
 * for the page lifetime; provide your own to persist across reloads.
 *
 * Privacy note: persisted plaintext sits unencrypted at rest unless
 * your impl encrypts. For sensitive use, layer NIP-44 derived KEK
 * encryption around the JSON before writing.
 */
export interface DMStorage {
  load(myPubkey: string): Promise<Record<string, DMMessage[]>>;
  save(myPubkey: string, conversations: Record<string, DMMessage[]>): Promise<void>;
}

export type SendDMOptions = {
  /** "nip17" (default) for sealed messages, "nip04" for legacy. */
  scheme?: "nip04" | "nip17";
};

export type DraftMessage = Pick<UnsignedEvent, "content" | "tags">;
