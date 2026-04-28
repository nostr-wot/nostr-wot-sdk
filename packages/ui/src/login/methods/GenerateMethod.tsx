"use client";

import { useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { PrivateKeySigner } from "@nostr-wot/signers";
import { useLogin } from "@nostr-wot/data/react";

const REMEMBER_KEY = "@nostr-wot/ui:nsec";

export function GenerateMethod({
  onError,
  onDone,
  onBack,
}: {
  onError: (msg: string) => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const login = useLogin();
  const [acknowledged, setAcknowledged] = useState(false);
  const [remember, setRemember] = useState(false);

  const generated = useMemo(() => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const nsec = nip19.nsecEncode(sk);
    const npub = nip19.npubEncode(pk);
    return { sk, pk, nsec, npub };
  }, []);

  const copy = (val: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(val);
    }
  };

  const download = () => {
    const blob = new Blob(
      [`Nostr private key (nsec)\n\n${generated.nsec}\n\nPublic key (npub)\n\n${generated.npub}\n\nKEEP THIS FILE PRIVATE.\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nostr-key-${generated.npub.slice(0, 12)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const finish = async () => {
    try {
      const signer = new PrivateKeySigner(generated.sk);
      if (remember) {
        try {
          localStorage.setItem(REMEMBER_KEY, generated.nsec);
        } catch {
          /* ignore quota */
        }
      }
      await login(signer);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button type="button" className="nui-back" onClick={onBack}>
        ← Back
      </button>

      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Your new key</h3>
      <p style={{ margin: 0, fontSize: 13, color: "var(--nui-muted)" }}>
        Back this up <strong>before</strong> you continue. Lose it and your
        identity is gone — there's no recovery.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, color: "var(--nui-muted)", fontWeight: 500 }}>
          Public key (npub)
        </span>
        <div className="nui-key-display">{generated.npub}</div>
        <button
          type="button"
          className="nui-back"
          style={{ alignSelf: "flex-end" }}
          onClick={() => copy(generated.npub)}
        >
          Copy npub
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, color: "var(--nui-muted)", fontWeight: 500 }}>
          Private key (nsec) — keep secret
        </span>
        <div className="nui-key-display">{generated.nsec}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="nui-back" onClick={() => copy(generated.nsec)}>
            Copy nsec
          </button>
          <button type="button" className="nui-back" onClick={download}>
            Download .txt
          </button>
        </div>
      </div>

      <label className="nui-warning" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          I have backed up my nsec. I understand that losing it means losing
          access to this account permanently.
        </span>
      </label>

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
        Remember on this device (saves nsec to localStorage — convenient but
        less secure)
      </label>

      <button
        type="button"
        className="nui-login-button"
        onClick={finish}
        disabled={!acknowledged}
        style={{ width: "100%", justifyContent: "center" }}
      >
        Continue
      </button>
    </div>
  );
}

/** Read a saved nsec from localStorage; returns a signer or null. */
export function tryRestoreGeneratedOrImported(): PrivateKeySigner | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const nsec = localStorage.getItem(REMEMBER_KEY);
    if (!nsec) return null;
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") return null;
    return new PrivateKeySigner(decoded.data);
  } catch {
    return null;
  }
}

export function clearPersistedNsec(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* ignore */
  }
}
