"use client";

import { useState, type ReactNode } from "react";
import {
  isNip07Available,
  type NostrSigner,
} from "@nostr-wot/signers";
import { useLogin, useLogout } from "@nostr-wot/data/react";
import { cx } from "../utils";
import type { ClassSlots, LoginMethodId, LoginWidgetSlot, StyleSlots } from "../types";
import { performBackendAuth } from "../auth-handshake";
import { Nip07Method } from "./methods/Nip07Method";
import { Nip46Method } from "./methods/Nip46Method";
import { GenerateMethod } from "./methods/GenerateMethod";
import { ImportMethod } from "./methods/ImportMethod";

export interface LoginWidgetSlotsProp {
  /** Above the title — usually a logo or app name. */
  header?: ReactNode;
  /** Below all methods — usually TOS / privacy links. */
  footer?: ReactNode;
  /** Between the title block and the method list. */
  beforeMethods?: ReactNode;
  /** Between the method list and the footer. */
  afterMethods?: ReactNode;
}

export interface LoginWidgetProps {
  /** Title shown at the top. Default "Sign in to Nostr". */
  title?: ReactNode;
  /** Subtitle / supporting copy under the title. */
  subtitle?: ReactNode;
  /** Branding slots — render arbitrary nodes around the methods. */
  slots?: LoginWidgetSlotsProp;
  /**
   * Methods to show, in order. Default is all four with `generate` +
   * `import` collapsed under an "Advanced" expand. Pass an explicit
   * subset to lock the choices.
   */
  methods?: LoginMethodId[];
  /**
   * Async login hook. Awaited after the signer attaches but BEFORE the
   * modal closes. Throw to keep the modal open + display the error in
   * the inline `nui-error` slot. Receives `{ signer, pubkey }`.
   *
   * If you also pass `authBaseUrl`, the backend handshake runs first;
   * `onLogin` runs only on success.
   */
  onLogin?: (args: { signer: NostrSigner; pubkey: string }) => Promise<void> | void;
  /** Fire-and-forget callback fired after `onLogin` resolves. */
  onSuccess?: () => void;
  /** Inline error display callback (besides the `nui-error` region). */
  onError?: (message: string) => void;
  /**
   * Mount point of `@nostr-wot/auth` server handlers (e.g. `/api/auth`).
   * When set, the widget runs the challenge → sign → verify flow and
   * persists the JWT cookie automatically. Errors here are surfaced in
   * the inline error region; the modal stays open.
   */
  authBaseUrl?: string;
  /** When `authBaseUrl` is set: roll back the local signer if the backend
   *  handshake fails. Default false (keep the local signer; user can retry). */
  rollbackOnAuthFailure?: boolean;
  /** Hide the "Advanced" disclosure for generate + import. Default false. */
  hideAdvanced?: boolean;
  /**
   * Renderable shown below the methods when `nip07` is in the method list
   * but no `window.nostr` is detected. Default: a CTA pointing to
   * https://nostr-wot.com/download. Pass `false` to suppress entirely or
   * a `ReactNode` to fully customize.
   */
  noExtensionCta?: ReactNode | false;
  /** When true, the "Generate" flow shows a profile-setup step (name /
   *  about / picture) and publishes a kind-0 event. Default false. */
  profileSetup?: boolean;
  /** Relays to publish the kind-0 to when `profileSetup` is on. */
  profileRelays?: string[];
  /** Default tab on the NIP-46 form: QR or paste-bunker-URI. Default "qr". */
  nip46Mode?: "qr" | "paste";
  /** Relays to advertise on the nostrconnect QR. */
  nip46Relays?: string[];
  /** App metadata embedded in the nostrconnect QR. */
  nip46Metadata?: { name?: string; url?: string; description?: string; image?: string };
  /** NIP-46 perms string (`sign_event:1,nip44_encrypt,...`). */
  nip46Perms?: string;
  classes?: ClassSlots<LoginWidgetSlot>;
  styles?: StyleSlots<LoginWidgetSlot>;
}

const DEFAULT_METHODS: LoginMethodId[] = ["nip07", "nip46", "generate", "import"];

const DEFAULT_NO_EXTENSION_CTA: ReactNode = (
  <a
    href="https://nostr-wot.com/download"
    target="_blank"
    rel="noreferrer noopener"
    className="nui-no-extension-cta"
  >
    <span className="nui-no-extension-icon" aria-hidden>🛡️</span>
    <span>
      <span className="nui-no-extension-title">Get the Nostr WoT extension</span>
      <span className="nui-no-extension-hint">
        Browser extension with NIP-07 signer + Web of Trust spam filtering ↗
      </span>
    </span>
  </a>
);

/**
 * Inline login widget. Renders the chosen login methods + handles state
 * transitions between picker / form / generated-key views. Backend
 * handshake (when `authBaseUrl` is set) and `onLogin` run after the
 * signer is attached and before the widget signals success.
 */
export function LoginWidget({
  title = "Sign in to Nostr",
  subtitle,
  slots,
  methods = DEFAULT_METHODS,
  onLogin,
  onSuccess,
  onError,
  authBaseUrl,
  rollbackOnAuthFailure = false,
  hideAdvanced = false,
  noExtensionCta,
  profileSetup = false,
  profileRelays,
  nip46Mode = "qr",
  nip46Relays,
  nip46Metadata,
  nip46Perms,
  classes,
  styles,
}: LoginWidgetProps) {
  const login = useLogin();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<
    | { kind: "picker" }
    | { kind: "nip46-form" }
    | { kind: "generate" }
    | { kind: "import" }
  >({ kind: "picker" });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const onErr = (msg: string) => {
    setError(msg);
    onError?.(msg);
  };

  /**
   * Central handler invoked by every login method once it has a signer.
   * Runs in order: setSigner(context) → backend handshake (if configured)
   * → user `onLogin` hook → onSuccess. Errors at any step keep the modal
   * open with an inline message; `rollbackOnAuthFailure` controls whether
   * the local signer is unset on backend failure.
   */
  const handleAttached = async (signer: NostrSigner, pubkey: string) => {
    setBusy(true);
    setError(null);
    let signerInContext = false;
    try {
      await login(signer);
      signerInContext = true;

      if (authBaseUrl) {
        try {
          await performBackendAuth(authBaseUrl, signer);
        } catch (err) {
          if (rollbackOnAuthFailure) {
            await logout();
            signerInContext = false;
          }
          throw err;
        }
      }

      if (onLogin) {
        await onLogin({ signer, pubkey });
      }

      onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onErr(msg);
      if (!signerInContext) {
        // Failed before context update → nothing to roll back.
      }
      throw err; // re-throw so the calling method can stop its UI spinner
    } finally {
      setBusy(false);
    }
  };

  const safeAttached = async (signer: NostrSigner, pubkey: string) => {
    try {
      await handleAttached(signer, pubkey);
    } catch {
      /* error already surfaced via onErr; swallow so methods don't double-handle */
    }
  };

  const primaryMethods = methods.filter((m) => m === "nip07" || m === "nip46");
  const advancedMethods = methods.filter((m) => m === "generate" || m === "import");

  const ctaToRender =
    noExtensionCta === false
      ? null
      : noExtensionCta !== undefined
        ? noExtensionCta
        : DEFAULT_NO_EXTENSION_CTA;

  return (
    <div className={cx("nui-widget", classes?.root)} style={styles?.root}>
      {slots?.header}

      <div>
        {title && (
          <h2
            className={cx("nui-widget-title", classes?.title)}
            style={styles?.title}
          >
            {title}
          </h2>
        )}
        {subtitle && (
          <p
            className={cx("nui-widget-subtitle", classes?.subtitle)}
            style={styles?.subtitle}
          >
            {subtitle}
          </p>
        )}
      </div>

      {slots?.beforeMethods}

      {error && (
        <div className={cx("nui-error", classes?.error)} style={styles?.error}>
          {error}
        </div>
      )}

      {busy && view.kind !== "picker" && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--nui-muted)",
            fontSize: 13,
          }}
        >
          <span className="nui-spinner" /> Signing in…
        </div>
      )}

      {view.kind === "picker" && (
        <>
          <div
            className={cx("nui-widget-methods", classes?.methods)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              ...styles?.methods,
            }}
          >
            {primaryMethods.includes("nip07") && (
              <Nip07Method onError={onErr} onAttached={safeAttached} />
            )}
            {primaryMethods.includes("nip46") && (
              <button
                type="button"
                className={cx("nui-method-button", classes?.method)}
                style={styles?.method}
                onClick={() => setView({ kind: "nip46-form" })}
              >
                <span
                  className={cx("nui-method-icon", classes?.methodIcon)}
                  aria-hidden
                >
                  🔐
                </span>
                <span className={cx("nui-method-text", classes?.methodText)}>
                  <span
                    className={cx("nui-method-label", classes?.methodLabel)}
                  >
                    Remote signer (bunker)
                  </span>
                  <span
                    className={cx("nui-method-hint", classes?.methodHint)}
                  >
                    NIP-46 — Amber, Nsec.app
                  </span>
                </span>
              </button>
            )}
          </div>

          {advancedMethods.length > 0 && !hideAdvanced && (
            <>
              {!showAdvanced ? (
                <button
                  type="button"
                  className={cx("nui-back", classes?.back)}
                  style={{ alignSelf: "center", ...styles?.back }}
                  onClick={() => setShowAdvanced(true)}
                >
                  Advanced ▾
                </button>
              ) : (
                <>
                  <div
                    className={cx("nui-divider", classes?.divider)}
                    style={styles?.divider}
                  >
                    Advanced
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {advancedMethods.includes("generate") && (
                      <button
                        type="button"
                        className={cx("nui-method-button", classes?.method)}
                        style={styles?.method}
                        onClick={() => setView({ kind: "generate" })}
                      >
                        <span className="nui-method-icon" aria-hidden>✨</span>
                        <span className="nui-method-text">
                          <span className="nui-method-label">
                            Create a new account
                          </span>
                          <span className="nui-method-hint">
                            Generates a fresh keypair on this device
                          </span>
                        </span>
                      </button>
                    )}
                    {advancedMethods.includes("import") && (
                      <button
                        type="button"
                        className={cx("nui-method-button", classes?.method)}
                        style={styles?.method}
                        onClick={() => setView({ kind: "import" })}
                      >
                        <span className="nui-method-icon" aria-hidden>🔑</span>
                        <span className="nui-method-text">
                          <span className="nui-method-label">
                            Paste private key
                          </span>
                          <span className="nui-method-hint">
                            nsec or 64-char hex — risky in browsers
                          </span>
                        </span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {!isNip07Available() && primaryMethods.includes("nip07") && ctaToRender}
        </>
      )}

      {view.kind === "nip46-form" && (
        <Nip46Method
          inline
          defaultMode={nip46Mode}
          onError={onErr}
          onAttached={safeAttached}
          onBack={() => setView({ kind: "picker" })}
          {...(nip46Relays ? { nostrConnectRelays: nip46Relays } : {})}
          {...(nip46Metadata ? { metadata: nip46Metadata } : {})}
          {...(nip46Perms ? { perms: nip46Perms } : {})}
        />
      )}
      {view.kind === "generate" && (
        <GenerateMethod
          onError={onErr}
          onAttached={safeAttached}
          onBack={() => setView({ kind: "picker" })}
          profileSetup={profileSetup}
          {...(profileRelays ? { profileRelays } : {})}
        />
      )}
      {view.kind === "import" && (
        <ImportMethod
          onError={onErr}
          onAttached={safeAttached}
          onBack={() => setView({ kind: "picker" })}
        />
      )}

      {slots?.afterMethods}
      {slots?.footer}
    </div>
  );
}
