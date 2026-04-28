/**
 * Pluggable storage for the bits the login flows need to persist:
 *   - NIP-46 pairing record (`@nostr-wot/ui:nip46`)
 *   - Remembered nsec for Generate/Import (`@nostr-wot/ui:nsec`)
 *
 * The default writes plaintext to `localStorage`. Apps that need
 * stronger at-rest guarantees (encrypted with a WebAuthn-pinned key,
 * IndexedDB-backed AES-GCM, server-side, etc.) implement this interface
 * and pass the instance to `<NostrSessionProvider signerStorage={...}>`.
 *
 * Methods may be sync or async — the SDK awaits everything internally.
 */
export interface SignerStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** Default: plaintext localStorage. SSR-safe (returns null when window is absent). */
export const localStorageSignerStorage: SignerStorage = {
  getItem(key) {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* quota / private mode */
    }
  },
  removeItem(key) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const SIGNER_STORAGE_KEY_NIP46 = "@nostr-wot/ui:nip46";
export const SIGNER_STORAGE_KEY_NSEC = "@nostr-wot/ui:nsec";
