"use client";

import { useEffect, useRef, useState } from "react";
import { Nip46Signer, type NostrConnectHandle } from "@nostr-wot/signers";
import { nip19 } from "nostr-tools";
import QRCode from "qrcode";
import { useLogin } from "@nostr-wot/data/react";

const STORAGE_KEY = "@nostr-wot/ui:nip46";

interface PersistedNip46 {
  /** The bunker URI (when pairing started via paste). */
  uri?: string;
  /** The bunker pubkey + relays (when pairing started via nostrconnect QR). */
  bunkerPubkey?: string;
  relays?: string[];
  clientNsec: string;
}

/** Read-only helper exported for the session-restore path. */
export function readPersistedNip46(): PersistedNip46 | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedNip46) : null;
  } catch {
    return null;
  }
}

export function clearPersistedNip46(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const DEFAULT_NOSTRCONNECT_RELAYS = [
  "wss://relay.nsec.app",
  "wss://relay.damus.io",
];

export interface Nip46MethodProps {
  onError: (msg: string) => void;
  onDone: () => void;
  onBack?: () => void;
  /** Skip the entry button and render the form/QR directly. */
  inline?: boolean;
  /** Default tab when both modes are available. Default "qr". */
  defaultMode?: "qr" | "paste";
  /** Relays to advertise on the nostrconnect QR. Defaults to nsec.app + damus. */
  nostrConnectRelays?: string[];
  /** App metadata in the QR URI (name shown to the user during pairing). */
  metadata?: { name?: string; url?: string; description?: string; image?: string };
  /** Permissions to request (NIP-46 perms string). */
  perms?: string;
}

export function Nip46Method({
  onError,
  onDone,
  onBack,
  inline = false,
  defaultMode = "qr",
  nostrConnectRelays = DEFAULT_NOSTRCONNECT_RELAYS,
  metadata,
  perms,
}: Nip46MethodProps) {
  const login = useLogin();
  const [stage, setStage] = useState<"button" | "form">(inline ? "form" : "button");
  const [mode, setMode] = useState<"qr" | "paste">(defaultMode);

  // Paste flow state
  const [uri, setUri] = useState("");
  const [pasting, setPasting] = useState(false);

  // QR flow state
  const handleRef = useRef<NostrConnectHandle | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [slowHint, setSlowHint] = useState(false);

  // Auth-URL challenge banner (shared)
  const [authChallenge, setAuthChallenge] = useState<string | null>(null);

  const startQr = async () => {
    setWaiting(true);
    setSlowHint(false);
    setAuthChallenge(null);
    try {
      const handle = Nip46Signer.startNostrConnect({
        relays: nostrConnectRelays,
        ...(metadata ? { metadata } : {}),
        ...(perms ? { perms } : {}),
        onAuthChallenge: (url) => setAuthChallenge(url),
      });
      handleRef.current = handle;
      setQrUri(handle.uri);
      const svg = await QRCode.toString(handle.uri, {
        type: "svg",
        margin: 1,
        width: 240,
      });
      setQrSvg(svg);

      const slowTimer = setTimeout(() => setSlowHint(true), 10_000);
      try {
        const signer = await handle.ready;
        clearTimeout(slowTimer);
        const clientNsec = signer.exportClientNsec();
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              bunkerPubkey: signer.bunkerPubkey,
              relays: signer.relays,
              clientNsec,
            } satisfies PersistedNip46),
          );
        } catch {
          /* ignore quota */
        }
        await login(signer);
        onDone();
      } catch (err) {
        clearTimeout(slowTimer);
        if (handleRef.current === handle) {
          onError(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWaiting(false);
    }
  };

  const cancelQr = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setQrSvg(null);
    setQrUri(null);
    setWaiting(false);
    setSlowHint(false);
    setAuthChallenge(null);
  };

  // Auto-start QR on mount when QR mode is the default
  useEffect(() => {
    if (stage !== "form" || mode !== "qr") return;
    if (qrSvg || waiting) return;
    void startQr();
    return () => {
      handleRef.current?.cancel();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, mode]);

  const connectPaste = async () => {
    const trimmed = uri.trim();
    if (!trimmed.startsWith("bunker://")) {
      onError("Paste a bunker:// URI from your remote signer.");
      return;
    }
    setPasting(true);
    setAuthChallenge(null);
    try {
      const signer = await Nip46Signer.fromBunkerUri(trimmed, {
        onAuthChallenge: (url) => setAuthChallenge(url),
      });
      const clientNsec = signer.exportClientNsec();
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            uri: trimmed,
            clientNsec,
          } satisfies PersistedNip46),
        );
      } catch {
        /* ignore */
      }
      await login(signer);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasting(false);
    }
  };

  if (stage === "button") {
    return (
      <button
        type="button"
        className="nui-method-button"
        onClick={() => setStage("form")}
      >
        <span className="nui-method-icon" aria-hidden>🔐</span>
        <span className="nui-method-text">
          <span className="nui-method-label">Remote signer (bunker)</span>
          <span className="nui-method-hint">NIP-46 — Amber, Nsec.app, Keychat</span>
        </span>
      </button>
    );
  }

  return (
    <div className="nui-nip46" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {onBack && (
        <button
          type="button"
          className="nui-back"
          onClick={() => {
            cancelQr();
            onBack();
          }}
        >
          ← Back
        </button>
      )}

      {/* Mode tabs */}
      <div className="nui-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "qr"}
          className={`nui-tab ${mode === "qr" ? "nui-tab-active" : ""}`}
          onClick={() => {
            cancelQr();
            setMode("qr");
          }}
        >
          Scan QR
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "paste"}
          className={`nui-tab ${mode === "paste" ? "nui-tab-active" : ""}`}
          onClick={() => {
            cancelQr();
            setMode("paste");
          }}
        >
          Paste URI
        </button>
      </div>

      {authChallenge && (
        <a
          href={authChallenge}
          target="_blank"
          rel="noreferrer noopener"
          className="nui-auth-banner"
        >
          <span style={{ fontWeight: 600 }}>Action required</span>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            Approve the request in your signer app, then this will continue automatically.
            Click to open ↗
          </span>
        </a>
      )}

      {mode === "qr" ? (
        <div className="nui-qr-wrap">
          {qrSvg ? (
            <>
              <div
                className="nui-qr"
                aria-label="Nostr Connect QR code"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <p className="nui-qr-hint">
                Scan with Amber, Nsec.app, Keychat, or any NIP-46 signer.
              </p>
              {slowHint && (
                <p className="nui-qr-slow-hint">
                  Still waiting? Some signer apps default to "scan once" — try
                  re-opening the scanner.
                </p>
              )}
              {qrUri && (
                <details style={{ fontSize: 12 }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      color: "var(--nui-muted)",
                      textAlign: "center",
                    }}
                  >
                    Or copy the connect URI
                  </summary>
                  <div className="nui-key-display" style={{ marginTop: 8 }}>
                    {qrUri}
                  </div>
                </details>
              )}
              <button
                type="button"
                className="nui-back"
                style={{ alignSelf: "center" }}
                onClick={() => {
                  cancelQr();
                  void startQr();
                }}
              >
                Restart
              </button>
            </>
          ) : (
            <div style={{ textAlign: "center", color: "var(--nui-muted)" }}>
              <span className="nui-spinner" /> Generating QR…
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label
            htmlFor="nui-bunker-uri"
            style={{ fontSize: 13, color: "var(--nui-muted)" }}
          >
            Paste a bunker:// URI from your remote signer
          </label>
          <input
            id="nui-bunker-uri"
            className="nui-input"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="bunker://abc...?relay=wss://..."
            autoFocus
          />
          <button
            type="button"
            className="nui-login-button"
            onClick={connectPaste}
            disabled={pasting || !uri}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pasting ? (
              <>
                Connecting <span className="nui-spinner" />
              </>
            ) : (
              "Connect"
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** Helper for app-level silent-restore on mount. Returns null on any error. */
export async function tryRestoreNip46(): Promise<Nip46Signer | null> {
  const persisted = readPersistedNip46();
  if (!persisted) return null;
  try {
    const decoded = nip19.decode(persisted.clientNsec);
    if (decoded.type !== "nsec") return null;
    if (persisted.uri) {
      return await Nip46Signer.fromBunkerUri(persisted.uri, {
        clientSecretKey: decoded.data,
      });
    }
    if (persisted.bunkerPubkey && persisted.relays) {
      // Reconstruct a signer that's already paired (no QR re-pair needed).
      const handle = Nip46Signer.startNostrConnect({
        relays: persisted.relays,
        clientSecretKey: decoded.data,
      });
      // Emulate the post-pair state directly: cancel the pending pairing
      // since we already know the bunker pubkey, and use the bunkerUri
      // shape going forward. Cleanest path: build a synthetic bunker URI.
      handle.cancel();
      const fakeBunkerUri =
        `bunker://${persisted.bunkerPubkey}?` +
        persisted.relays.map((r) => `relay=${encodeURIComponent(r)}`).join("&");
      return await Nip46Signer.fromBunkerUri(fakeBunkerUri, {
        clientSecretKey: decoded.data,
      });
    }
    return null;
  } catch {
    return null;
  }
}
