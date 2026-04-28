/**
 * At-rest encryption for the DM cache.
 *
 * Plaintext DM bodies in localStorage are an XSS exfiltration risk. This
 * module wraps any `DMStorage` with a per-account symmetric KEK:
 *
 *   - 32 random bytes generated locally
 *   - NIP-44-self-encrypted by the user's signer (only their nsec /
 *     extension / bunker can recover the key)
 *   - persisted in that wrapped form
 *   - imported as a non-extractable WebCrypto AES-GCM key — XSS can call
 *     our encrypt/decrypt helpers but cannot exfiltrate the raw bytes
 *
 * Lifted from obelisk's `dm/cache-key.ts` so any client can opt into
 * encrypted-at-rest DM caching with one wrapper call.
 */

import type { NostrSigner } from "@nostr-wot/signers";
import type { DMMessage, DMStorage } from "./types";

const KEY_PREFIX = "@nostr-wot/dm:cache-key:";
const ramKeys = new Map<string, CryptoKey>();

/** Test/lifecycle helper. */
export function _resetCacheKeyState(): void {
  ramKeys.clear();
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Get-or-mint the per-account cache key. Idempotent: subsequent calls in
 * the same session return the cached `CryptoKey` directly (no signer
 * prompts).
 *
 * The signer is consulted ONCE per session (or whenever localStorage is
 * cleared). Subsequent encrypt/decrypt operations use only WebCrypto.
 */
export async function getOrCreateCacheKey(
  myPubkey: string,
  signer: NostrSigner,
): Promise<CryptoKey> {
  const cached = ramKeys.get(myPubkey);
  if (cached) return cached;

  if (!signer.nip44Encrypt || !signer.nip44Decrypt) {
    throw new Error(
      "Signer does not support NIP-44 (required to wrap the cache key)",
    );
  }

  const storageKey = KEY_PREFIX + myPubkey;
  let rawB64: string;

  const wrapped =
    typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
  if (wrapped) {
    rawB64 = await signer.nip44Decrypt(myPubkey, wrapped);
  } else {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    rawB64 = bytesToBase64(raw);
    const wrappedNew = await signer.nip44Encrypt(myPubkey, rawB64);
    if (typeof localStorage !== "undefined")
      localStorage.setItem(storageKey, wrappedNew);
  }

  const raw = base64ToBytes(rawB64);
  const key = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
  // Best-effort: zero the post-import buffer. The base64 string is still
  // GC-pinned for now, so this closes only one of several windows.
  raw.fill(0);

  ramKeys.set(myPubkey, key);
  return key;
}

/** Encrypt a single string to base64(iv).base64(ciphertext). */
export async function encryptToCache(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(ct)}`;
}

export async function decryptFromCache(
  key: CryptoKey,
  blob: string,
): Promise<string> {
  const parts = blob.split(".");
  if (parts.length !== 2) throw new Error("Malformed cache blob");
  const iv = base64ToBytes(parts[0]!);
  const ct = base64ToBytes(parts[1]!);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

/**
 * Wrap any `DMStorage` with at-rest encryption using `key`. Each
 * conversation array is JSON-stringified, AES-GCM-encrypted, and stored
 * under the same partition key. On load, decrypt blobs back to
 * `DMMessage[]` per partner.
 *
 * Use:
 *   const inner = localStorageDMStorage();
 *   const key = await getOrCreateCacheKey(myPubkey, signer);
 *   const encrypted = wrapStorageWithEncryption(inner, key);
 *   await initDMSession({ myPubkey, signer, relays, storage: encrypted });
 */
export function wrapStorageWithEncryption(
  inner: DMStorage,
  key: CryptoKey,
): DMStorage {
  return {
    async load(myPubkey: string): Promise<Record<string, DMMessage[]>> {
      const raw = await inner.load(myPubkey);
      const out: Record<string, DMMessage[]> = {};
      for (const [partner, blobs] of Object.entries(raw)) {
        // The wrapped cache stores ciphertext blobs in the message.content
        // slot; everything else (id, fromPubkey, partnerPubkey, createdAt,
        // scheme) is metadata and stays in plaintext for indexing.
        const decoded: DMMessage[] = [];
        for (const m of blobs) {
          try {
            const plain = await decryptFromCache(key, m.content);
            decoded.push({ ...m, content: plain });
          } catch {
            /* skip un-decryptable rows (cache key rotated, corrupt, etc.) */
          }
        }
        out[partner] = decoded;
      }
      return out;
    },
    async save(
      myPubkey: string,
      conversations: Record<string, DMMessage[]>,
    ): Promise<void> {
      const wrapped: Record<string, DMMessage[]> = {};
      for (const [partner, msgs] of Object.entries(conversations)) {
        const arr: DMMessage[] = [];
        for (const m of msgs) {
          const ct = await encryptToCache(key, m.content);
          arr.push({ ...m, content: ct });
        }
        wrapped[partner] = arr;
      }
      await inner.save(myPubkey, wrapped);
    },
  };
}
