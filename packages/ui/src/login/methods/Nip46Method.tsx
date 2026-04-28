"use client";

import { useState } from "react";
import { Nip46Signer } from "@nostr-wot/signers";
import { nip19 } from "nostr-tools";
import { useLogin } from "@nostr-wot/data/react";

const STORAGE_KEY = "@nostr-wot/ui:nip46";

interface PersistedNip46 {
  uri: string;
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

export function Nip46Method({
  onError,
  onDone,
  onBack,
  inline = false,
}: {
  onError: (msg: string) => void;
  onDone: () => void;
  onBack?: () => void;
  /** When true, render the connect form directly (no entry button). */
  inline?: boolean;
}) {
  const login = useLogin();
  const [stage, setStage] = useState<"button" | "form">(inline ? "form" : "button");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    const trimmed = uri.trim();
    if (!trimmed.startsWith("bunker://")) {
      onError("Paste a bunker:// URI from your remote signer.");
      return;
    }
    setBusy(true);
    try {
      const signer = await Nip46Signer.fromBunkerUri(trimmed);
      const clientNsec = signer.exportClientNsec();
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ uri: trimmed, clientNsec }),
        );
      } catch {
        /* ignore quota errors */
      }
      await login(signer);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {onBack && (
        <button type="button" className="nui-back" onClick={onBack}>
          ← Back
        </button>
      )}
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
        onClick={connect}
        disabled={busy || !uri}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {busy ? (
          <>
            Connecting <span className="nui-spinner" />
          </>
        ) : (
          "Connect"
        )}
      </button>
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
    return await Nip46Signer.fromBunkerUri(persisted.uri, {
      clientSecretKey: decoded.data,
    });
  } catch {
    return null;
  }
}
