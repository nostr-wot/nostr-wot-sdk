"use client";

import { useEffect, useRef, useState } from "react";
import {
  Nip46Signer,
  type NostrConnectHandle,
  type NostrSigner,
} from "@nostr-wot/signers";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import QRCode from "qrcode";

const STORAGE_KEY = "@nostr-wot/ui:nip46";

type Persisted =
  | {
      kind: "bunker";
      uri: string;
      clientNsec: string;
    }
  | {
      kind: "nostrconnect";
      bunkerPubkey: string;
      relays: string[];
      clientNsec: string;
    };

/** Saved either before pairing (clientNsec only — same key persists across attempts so the bunker remembers us) or after pairing (full record). */
function readPersisted(): Persisted | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

function writePersisted(p: Persisted): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota */
  }
}

export function readPersistedNip46(): {
  uri?: string;
  bunkerPubkey?: string;
  relays?: string[];
  clientNsec: string;
} | null {
  return readPersisted();
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

/** Get-or-mint a stable client nsec across pairing attempts so the bunker
 *  remembers us. Persisted under a sentinel key alongside the saved
 *  pairing record. The full pairing is overwritten on success. */
function getOrMintClientNsec(): string {
  const existing = readPersisted();
  if (existing?.clientNsec) return existing.clientNsec;
  const sk = generateSecretKey();
  return nip19.nsecEncode(sk);
}

function nsecToBytes(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec");
  return decoded.data;
}

export interface Nip46MethodProps {
  onError: (msg: string) => void;
  onAttached: (signer: NostrSigner, pubkey: string) => void | Promise<void>;
  onBack?: () => void;
  inline?: boolean;
  defaultMode?: "qr" | "paste";
  nostrConnectRelays?: string[];
  metadata?: { name?: string; url?: string; description?: string; image?: string };
  perms?: string;
}

export function Nip46Method({
  onError,
  onAttached,
  onBack,
  inline = false,
  defaultMode = "qr",
  nostrConnectRelays = DEFAULT_NOSTRCONNECT_RELAYS,
  metadata,
  perms,
}: Nip46MethodProps) {
  const [stage, setStage] = useState<"button" | "form">(inline ? "form" : "button");
  const [mode, setMode] = useState<"qr" | "paste">(defaultMode);

  const [uri, setUri] = useState("");
  const [pasting, setPasting] = useState(false);

  const handleRef = useRef<NostrConnectHandle | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [slowHint, setSlowHint] = useState(false);

  const [authChallenge, setAuthChallenge] = useState<string | null>(null);

  const startQr = async () => {
    setWaiting(true);
    setSlowHint(false);
    setAuthChallenge(null);
    try {
      // Mint or reuse a client nsec across attempts so the bunker
      // remembers us if the user closes + reopens before pairing.
      const clientNsec = getOrMintClientNsec();
      const clientSk = nsecToBytes(clientNsec);
      const clientPk = getPublicKey(clientSk);
      writePersisted({
        kind: "nostrconnect",
        bunkerPubkey: "",
        relays: nostrConnectRelays,
        clientNsec,
      });
      void clientPk;

      const handle = Nip46Signer.startNostrConnect({
        relays: nostrConnectRelays,
        clientSecretKey: clientSk,
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
        writePersisted({
          kind: "nostrconnect",
          bunkerPubkey: signer.bunkerPubkey,
          relays: signer.relays,
          clientNsec: signer.exportClientNsec(),
        });
        const pubkey = await signer.getPublicKey();
        await onAttached(signer, pubkey);
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
      writePersisted({ kind: "bunker", uri: trimmed, clientNsec });
      const pubkey = await signer.getPublicKey();
      await onAttached(signer, pubkey);
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

/** Helper for app-level silent-restore on mount. Only fires for *paired*
 *  records (full bunker URI or full nostrconnect record). Pre-pair
 *  clientNsecs are kept to maintain the same client identity across
 *  attempts but never restore a signer on their own. */
export async function tryRestoreNip46(): Promise<Nip46Signer | null> {
  const persisted = readPersisted();
  if (!persisted) return null;
  try {
    const decoded = nip19.decode(persisted.clientNsec);
    if (decoded.type !== "nsec") return null;
    if (persisted.kind === "bunker" && persisted.uri) {
      return await Nip46Signer.fromBunkerUri(persisted.uri, {
        clientSecretKey: decoded.data,
      });
    }
    if (
      persisted.kind === "nostrconnect" &&
      persisted.bunkerPubkey &&
      persisted.relays &&
      persisted.relays.length > 0
    ) {
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
