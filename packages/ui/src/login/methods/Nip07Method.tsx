"use client";

import { useState } from "react";
import { Nip07Signer, isNip07Available } from "@nostr-wot/signers";
import { useLogin } from "@nostr-wot/data/react";

export function Nip07Method({
  onError,
  onDone,
}: {
  onError: (msg: string) => void;
  onDone: () => void;
}) {
  const login = useLogin();
  const [busy, setBusy] = useState(false);

  const click = async () => {
    if (!isNip07Available()) {
      onError(
        "No NIP-07 extension detected. Install Alby, nos2x, or another Nostr signer extension and reload.",
      );
      return;
    }
    setBusy(true);
    try {
      const signer = new Nip07Signer();
      // Verify it works before committing — getPublicKey throws if the
      // user denies the permission request.
      await signer.getPublicKey();
      await login(signer);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="nui-method-button"
      onClick={click}
      data-busy={busy}
      disabled={busy}
    >
      <span className="nui-method-icon" aria-hidden>🔌</span>
      <span className="nui-method-text">
        <span className="nui-method-label">
          Browser extension
          {busy && <span className="nui-spinner" style={{ marginLeft: 8 }} />}
        </span>
        <span className="nui-method-hint">NIP-07 — Alby, nos2x, Flamingo</span>
      </span>
    </button>
  );
}
