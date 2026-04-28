"use client";

/**
 * Shared session context — the single mount point for the active
 * `NostrSigner` and the user's pubkey.
 *
 * Lives in `@nostr-wot/data/react` (not `@nostr-wot/ui`) so that
 * downstream packages — DM hooks, blossom uploads, wallet/zap hooks —
 * can read the signer from context without dragging in the entire UI
 * package. `@nostr-wot/ui` consumes the same context for its login flows.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Loose interface so we don't pull `@nostr-wot/signers` in as a hard
 * dependency of `@nostr-wot/data`. Any object satisfying this shape
 * (which `NostrSigner` from `@nostr-wot/signers` does by design) works.
 */
export interface SessionSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: unknown): Promise<unknown>;
  nip04Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
  close?(): Promise<void> | void;
}

export interface SessionState {
  /** The active signer, or `null` if logged out. */
  signer: SessionSigner | null;
  /** The signer's pubkey (resolved on login). */
  pubkey: string | null;
  /** Loading flag while a signer is being attached. */
  isLoading: boolean;
  /** Last login error, if any. */
  error: Error | null;
  /** Replace the active signer. Pass `null` to log out. */
  setSigner: (signer: SessionSigner | null) => Promise<void>;
  /** Convenience: drop the current signer + clear pubkey. */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export interface NostrSessionProviderProps {
  children: ReactNode;
  /** An initial signer (e.g. one your app constructed at boot). */
  initialSigner?: SessionSigner | null;
  /**
   * Called whenever the signer changes. Use to mirror auth state into
   * other systems (analytics, audit logs, server-side sessions).
   */
  onChange?: (state: { signer: SessionSigner | null; pubkey: string | null }) => void;
  /**
   * Called when `logout()` runs. Use to clear app-level caches that
   * don't subscribe to the session context directly.
   */
  onLogout?: () => void | Promise<void>;
}

export function NostrSessionProvider({
  children,
  initialSigner = null,
  onChange,
  onLogout,
}: NostrSessionProviderProps) {
  const [signer, setSignerState] = useState<SessionSigner | null>(initialSigner);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Resolve pubkey when the signer changes
  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setPubkey(null);
      onChange?.({ signer: null, pubkey: null });
      return;
    }
    void (async () => {
      setLoading(true);
      try {
        const pk = await signer.getPublicKey();
        if (cancelled) return;
        setPubkey(pk);
        setError(null);
        onChange?.({ signer, pubkey: pk });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setPubkey(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer]);

  const setSigner = useCallback(async (next: SessionSigner | null) => {
    setSignerState(next);
  }, []);

  const logout = useCallback(async () => {
    if (signer?.close) {
      try {
        await signer.close();
      } catch {
        /* ignore */
      }
    }
    setSignerState(null);
    setPubkey(null);
    setError(null);
    if (onLogout) await onLogout();
  }, [signer, onLogout]);

  const value: SessionState = useMemo(
    () => ({ signer, pubkey, isLoading, error, setSigner, logout }),
    [signer, pubkey, isLoading, error, setSigner, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Read the full session state. Returns a default (no-op) state if no provider is mounted. */
export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (ctx) return ctx;
  return defaultState;
}

/** The active signer, or `null`. Useful when explicitly passing to non-React APIs. */
export function useSigner(): SessionSigner | null {
  return useSession().signer;
}

/** The active user's hex pubkey, or `null`. */
export function usePubkey(): string | null {
  return useSession().pubkey;
}

/**
 * `setSigner` callback. Components implement their own login flows and
 * pass the resulting signer here.
 */
export function useLogin(): (signer: SessionSigner) => Promise<void> {
  const { setSigner } = useSession();
  return useCallback((s: SessionSigner) => setSigner(s), [setSigner]);
}

/** Drop the current signer + run any `onLogout` side-effects. */
export function useLogout(): () => Promise<void> {
  return useSession().logout;
}

const defaultState: SessionState = {
  signer: null,
  pubkey: null,
  isLoading: false,
  error: null,
  setSigner: async () => {},
  logout: async () => {},
};
