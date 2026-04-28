"use client";

import { useState } from "react";
import {
  Nip07Signer,
  isNip07Available,
  type NostrSigner,
} from "@nostr-wot/signers";

export function Nip07Method({
  onError,
  onAttached,
}: {
  onError: (msg: string) => void;
  onAttached: (signer: NostrSigner, pubkey: string) => void | Promise<void>;
}) {
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
      const pubkey = await signer.getPublicKey();
      await onAttached(signer, pubkey);
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
