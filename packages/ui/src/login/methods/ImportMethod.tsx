"use client";

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { PrivateKeySigner } from "@nostr-wot/signers";
import { useLogin } from "@nostr-wot/data/react";

const REMEMBER_KEY = "@nostr-wot/ui:nsec";

export function ImportMethod({
  onError,
  onDone,
  onBack,
}: {
  onError: (msg: string) => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const login = useLogin();
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      let secretKey: Uint8Array;
      let nsec: string;
      if (trimmed.startsWith("nsec1")) {
        const decoded = nip19.decode(trimmed);
        if (decoded.type !== "nsec") throw new Error("Invalid nsec");
        secretKey = decoded.data;
        nsec = trimmed;
      } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
        }
        secretKey = bytes;
        nsec = nip19.nsecEncode(bytes);
      } else {
        throw new Error("Paste an nsec1… or a 64-char hex private key.");
      }
      const signer = new PrivateKeySigner(secretKey);
      if (remember) {
        try {
          localStorage.setItem(REMEMBER_KEY, nsec);
        } catch {
          /* ignore */
        }
      }
      await login(signer);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button type="button" className="nui-back" onClick={onBack}>
        ← Back
      </button>

      <p className="nui-warning">
        ⚠️ Pasting your private key into a web page is risky. Prefer a browser
        extension (NIP-07) or a remote signer (NIP-46) when possible.
      </p>

      <input
        className="nui-input"
        type="password"
        autoFocus
        placeholder="nsec1… or 64-char hex"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />

      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 13,
          color: "var(--nui-muted)",
        }}
      >
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        Remember on this device
      </label>

      <button
        type="button"
        className="nui-login-button"
        onClick={submit}
        disabled={busy || !value}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {busy ? <>Signing in <span className="nui-spinner" /></> : "Sign in"}
      </button>
    </div>
  );
}
