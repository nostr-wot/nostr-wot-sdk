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
  tryRestoreNip46,
  clearPersistedNip46,
} from "./login/methods/Nip46Method";
import {
  tryRestoreGeneratedOrImported,
  clearPersistedNsec,
} from "./login/methods/GenerateMethod";

export interface NostrSessionProviderProps extends BaseProviderProps {
  /** Theme override for the default stylesheet. Default: follow system. */
  theme?: "light" | "dark" | "system";
  /**
   * Attempt silent restore of the previous signer on mount. Default true.
   * Disable if your app handles signer construction itself.
   */
  autoRestore?: boolean;
}

/**
 * `<NostrSessionProvider>` from `@nostr-wot/ui` is a small shell on top
 * of the `@nostr-wot/data/react` session provider:
 *
 *   - Sets `data-nui-root` (and `data-nui-theme` when forced) on the
 *     wrapper so the default stylesheet can scope its CSS variables.
 *   - On mount, attempts to silently re-attach the user's previous
 *     signer (NIP-46 from saved bunker URI; remembered nsec). Skips if
 *     no method was previously persisted.
 *
 * If you don't import `@nostr-wot/ui/styles.css`, the `data-nui-root`
 * attribute is harmless — components still render, just unstyled.
 */
export function NostrSessionProvider({
  theme = "system",
  autoRestore = true,
  children,
  ...rest
}: NostrSessionProviderProps) {
  return (
    <BaseProvider {...rest}>
      <div
        data-nui-root=""
        {...(theme !== "system" ? { "data-nui-theme": theme } : {})}
      >
        {autoRestore && <AutoRestore />}
        {children}
      </div>
    </BaseProvider>
  );
}

/** Internal: silent restore on first render. */
function AutoRestore() {
  const { signer } = useSession();
  const login = useLogin();

  useEffect(() => {
    if (signer) return; // already authed
    let cancelled = false;
    void (async () => {
      // Order: NIP-46 first (no prompt cost), then nsec (only if user
      // explicitly opted in).
      const ndk = await tryRestoreNip46();
      if (cancelled) return;
      if (ndk) {
        try {
          await login(ndk as unknown as SessionSigner);
        } catch {
          clearPersistedNip46();
        }
        return;
      }
      const stored = tryRestoreGeneratedOrImported();
      if (cancelled || !stored) return;
      try {
        await login(stored as unknown as SessionSigner);
      } catch {
        clearPersistedNsec();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
