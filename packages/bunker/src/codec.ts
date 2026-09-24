import { finalizeEvent, type VerifiedEvent } from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";
import { NostrConnect } from "nostr-tools/kinds";

/** The wire shape of a NIP-46 response, before encryption. */
export interface ResponsePayload {
  id: string;
  result?: string;
  error?: string;
}

/** A structurally valid decrypted request. */
export interface ParsedRequest {
  id: string;
  method: string;
  params: string[];
}

export function conversationKey(secretKey: Uint8Array, peerPubkey: string): Uint8Array {
  return nip44.utils.getConversationKey(secretKey, peerPubkey);
}

export function decryptPayload(ciphertext: string, key: Uint8Array): unknown {
  return JSON.parse(nip44.decrypt(ciphertext, key));
}

/**
 * Validate a decrypted request. Returns `null` when it cannot be answered at all
 * (no usable id or method). Non-string params are JSON-stringified rather than
 * rejected: the NIP says strings, but clients have shipped objects for
 * `sign_event`, and refusing them helps nobody.
 */
export function parseRequest(message: unknown): ParsedRequest | null {
  if (!message || typeof message !== "object") return null;
  const { id, method, params } = message as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return null;
  if (typeof method !== "string" || method.length === 0) return null;
  const list = Array.isArray(params) ? params : [];
  return {
    id,
    method,
    params: list.map((p) => (typeof p === "string" ? p : JSON.stringify(p ?? null))),
  };
}

/** Does the message at least carry a string id we could address an error to? */
export function extractId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
}

/** Encrypt a response to `clientPubkey` and sign it with the connection key. */
export function buildResponseEvent(
  secretKey: Uint8Array,
  clientPubkey: string,
  key: Uint8Array,
  payload: ResponsePayload,
): VerifiedEvent {
  const body: ResponsePayload = { id: payload.id };
  if (payload.result !== undefined) body.result = payload.result;
  if (payload.error !== undefined) body.error = payload.error;
  return finalizeEvent(
    {
      kind: NostrConnect,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", clientPubkey]],
      content: nip44.encrypt(JSON.stringify(body), key),
    },
    secretKey,
  );
}
