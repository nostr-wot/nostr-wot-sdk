"use client";

import { useEffect, type ReactNode } from "react";
import {
  NostrSessionProvider as BaseProvider,
  useLogin,
  useSession,
  type NostrSessionProviderProps as BaseProviderProps,
  type SessionSigner,
} from "@nostr-wot/data/react";
import {
  localStorageSignerStorage,
  type SignerStorage,
} from "./signer-storage";
import {
  SignerStorageProvider,
  useSignerStorage,
} from "./signer-storage-context";
import {
  tryRestoreNip46,
  clearPersistedNip46,
} from "./login/methods/Nip46Method";
import {
  tryRestoreGeneratedOrImported,
  clearPersistedNsec,
} from "./login/methods/GenerateMethod";

export interface NostrSessionProviderProps extends BaseProviderProps {
  /** Theme override for the default stylesheet. Default: follow system. */
  theme?: "light" | "dark" | "system" | "la-crypta";
  /**
   * Attempt silent restore of the previous signer on mount. Default true.
   * Disable if your app handles signer construction itself.
   */
  autoRestore?: boolean;
  /**
   * Pluggable storage for persisted login state (NIP-46 pairing, remembered
   * nsec). Default: plaintext localStorage. Apps that need encrypted-at-rest
   * (WebAuthn-pinned KEK, IndexedDB AES-GCM, …) implement `SignerStorage`
   * and pass it here. The same instance is consumed by `tryRestoreNip46`,
   * `tryRestoreGeneratedOrImported`, and the login methods.
   */
  signerStorage?: SignerStorage;
}

/**
 * `<NostrSessionProvider>` from `@nostr-wot/ui` is a small shell on top
 * of the `@nostr-wot/data/react` session provider:
 *
 *   - Sets `data-nui-root` (and `data-nui-theme` when forced) on the
 *     wrapper so the default stylesheet can scope its CSS variables.
 *   - Provides the `SignerStorage` adapter to all login methods.
 *   - On mount, attempts to silently re-attach the user's previous
 *     signer using the same storage. Skips if no record is found.
 *
 * If you don't import `@nostr-wot/ui/styles.css`, the `data-nui-root`
 * attribute is harmless — components still render, just unstyled.
 */
export function NostrSessionProvider({
  theme = "system",
  autoRestore = true,
  signerStorage = localStorageSignerStorage,
  children,
  ...rest
}: NostrSessionProviderProps) {
  return (
    <BaseProvider {...rest}>
      <SignerStorageProvider storage={signerStorage}>
        <div
          data-nui-root=""
          {...(theme !== "system" ? { "data-nui-theme": theme } : {})}
        >
          {autoRestore && <AutoRestore />}
          {children}
        </div>
      </SignerStorageProvider>
    </BaseProvider>
  );
}

/** Internal: silent restore on first render. */
function AutoRestore() {
  const { signer } = useSession();
  const login = useLogin();
  const storage = useSignerStorage();

  useEffect(() => {
    if (signer) return; // already authed
    let cancelled = false;
    void (async () => {
      // Order: NIP-46 first (no prompt cost), then nsec (only if user
      // explicitly opted in).
      const remote = await tryRestoreNip46(storage);
      if (cancelled) return;
      if (remote) {
        try {
          await login(remote as unknown as SessionSigner);
        } catch {
          await clearPersistedNip46(storage);
        }
        return;
      }
      const stored = await tryRestoreGeneratedOrImported(storage);
      if (cancelled || !stored) return;
      try {
        await login(stored as unknown as SessionSigner);
      } catch {
        await clearPersistedNsec(storage);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
