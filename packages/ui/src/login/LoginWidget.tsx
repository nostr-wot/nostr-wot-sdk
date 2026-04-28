"use client";

import { useState, type ReactNode } from "react";
import { isNip07Available } from "@nostr-wot/signers";
import { cx } from "../utils";
import type { ClassSlots, LoginMethodId, LoginWidgetSlot, StyleSlots } from "../types";
import { Nip07Method } from "./methods/Nip07Method";
import { Nip46Method } from "./methods/Nip46Method";
import { GenerateMethod } from "./methods/GenerateMethod";
import { ImportMethod } from "./methods/ImportMethod";

export interface LoginWidgetProps {
  /** Title shown at the top. Default "Sign in to Nostr". */
  title?: ReactNode;
  /** Subtitle / supporting copy under the title. */
  subtitle?: ReactNode;
  /**
   * Methods to show, in order. Default is all four with `generate` +
   * `import` collapsed under an "Advanced" expand. Pass an explicit
   * subset to lock the choices.
   */
  methods?: LoginMethodId[];
  /** Callback when login succeeds. */
  onSuccess?: () => void;
  /** Callback for error display (besides the inline error region). */
  onError?: (message: string) => void;
  /** Hide the "Advanced" disclosure for generate + import. Default false. */
  hideAdvanced?: boolean;
  /**
   * When true, the "Generate" flow shows a profile-setup step (name /
   * about / picture) and publishes a kind-0 event. Default false.
   */
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

/**
 * Inline login widget. Renders the chosen login methods + handles state
 * transitions between picker / form / generated-key views.
 *
 * Styling: every region exposes a class + style slot via `classes` /
 * `styles` props. CSS variables on `[data-nui-root]` (set by the
 * NostrSessionProvider) drive the default look.
 */
export function LoginWidget({
  title = "Sign in to Nostr",
  subtitle,
  methods = DEFAULT_METHODS,
  onSuccess,
  onError,
  hideAdvanced = false,
  profileSetup = false,
  profileRelays,
  nip46Mode = "qr",
  nip46Relays,
  nip46Metadata,
  nip46Perms,
  classes,
  styles,
}: LoginWidgetProps) {
  const [error, setError] = useState<string | null>(null);
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
  const onDone = () => {
    setError(null);
    onSuccess?.();
  };

  const primaryMethods = methods.filter((m) => m === "nip07" || m === "nip46");
  const advancedMethods = methods.filter((m) => m === "generate" || m === "import");

  return (
    <div
      className={cx("nui-widget", classes?.root)}
      style={styles?.root}
    >
      <div>
        {title && (
          <h2 className={cx("nui-widget-title", classes?.title)} style={styles?.title}>
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

      {error && (
        <div className={cx("nui-error", classes?.error)} style={styles?.error}>
          {error}
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
              <Nip07Method onError={onErr} onDone={onDone} />
            )}
            {primaryMethods.includes("nip46") && (
              <button
                type="button"
                className={cx("nui-method-button", classes?.method)}
                style={styles?.method}
                onClick={() => setView({ kind: "nip46-form" })}
              >
                <span className={cx("nui-method-icon", classes?.methodIcon)} aria-hidden>
                  🔐
                </span>
                <span className={cx("nui-method-text", classes?.methodText)}>
                  <span className={cx("nui-method-label", classes?.methodLabel)}>
                    Remote signer (bunker)
                  </span>
                  <span className={cx("nui-method-hint", classes?.methodHint)}>
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
                  <div className={cx("nui-divider", classes?.divider)} style={styles?.divider}>
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

          {!isNip07Available() && primaryMethods.includes("nip07") && (
            <p
              style={{
                fontSize: 12,
                color: "var(--nui-muted)",
                margin: 0,
                textAlign: "center",
              }}
            >
              No NIP-07 extension detected. Install Alby or nos2x to enable.
            </p>
          )}
        </>
      )}

      {view.kind === "nip46-form" && (
        <Nip46Method
          inline
          defaultMode={nip46Mode}
          onError={onErr}
          onDone={onDone}
          onBack={() => setView({ kind: "picker" })}
          {...(nip46Relays ? { nostrConnectRelays: nip46Relays } : {})}
          {...(nip46Metadata ? { metadata: nip46Metadata } : {})}
          {...(nip46Perms ? { perms: nip46Perms } : {})}
        />
      )}
      {view.kind === "generate" && (
        <GenerateMethod
          onError={onErr}
          onDone={onDone}
          onBack={() => setView({ kind: "picker" })}
          profileSetup={profileSetup}
          {...(profileRelays ? { profileRelays } : {})}
        />
      )}
      {view.kind === "import" && (
        <ImportMethod
          onError={onErr}
          onDone={onDone}
          onBack={() => setView({ kind: "picker" })}
        />
      )}
    </div>
  );
}
