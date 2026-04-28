"use client";

import { useMemo, useState } from "react";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
} from "nostr-tools";
import { PrivateKeySigner } from "@nostr-wot/signers";
import { getPool } from "@nostr-wot/data";
import { useLogin } from "@nostr-wot/data/react";

const REMEMBER_KEY = "@nostr-wot/ui:nsec";

export interface GenerateMethodProps {
  onError: (msg: string) => void;
  onDone: () => void;
  onBack: () => void;
  /**
   * When true, after the user confirms the backup, ask for name / about
   * / picture and publish a kind-0 event so their profile shows up
   * across Nostr clients.
   */
  profileSetup?: boolean;
  /** Relays to publish the profile to. Defaults to a tiny built-in set. */
  profileRelays?: string[];
}

const DEFAULT_PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
];

export function GenerateMethod({
  onError,
  onDone,
  onBack,
  profileSetup = false,
  profileRelays = DEFAULT_PROFILE_RELAYS,
}: GenerateMethodProps) {
  const login = useLogin();
  const [acknowledged, setAcknowledged] = useState(false);
  const [remember, setRemember] = useState(false);
  const [step, setStep] = useState<"backup" | "profile">("backup");
  const [publishing, setPublishing] = useState(false);

  // Profile fields
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");

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

  const persistAndLogin = async () => {
    const signer = new PrivateKeySigner(generated.sk);
    if (remember) {
      try {
        localStorage.setItem(REMEMBER_KEY, generated.nsec);
      } catch {
        /* ignore quota */
      }
    }
    await login(signer);
  };

  const continueToNext = async () => {
    try {
      if (profileSetup) {
        setStep("profile");
        return;
      }
      await persistAndLogin();
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitProfile = async (skipped: boolean) => {
    setPublishing(true);
    try {
      if (!skipped) {
        const content: Record<string, string> = {};
        if (name.trim()) {
          content.name = name.trim();
          content.display_name = name.trim();
        }
        if (about.trim()) content.about = about.trim();
        if (picture.trim()) content.picture = picture.trim();
        if (Object.keys(content).length > 0) {
          const event = finalizeEvent(
            {
              kind: 0,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: JSON.stringify(content),
            },
            generated.sk,
          );
          try {
            const pool = getPool();
            await Promise.allSettled(pool.publish(profileRelays, event));
          } catch {
            /* relay publish failures are non-fatal — the user is still logged in */
          }
        }
      }
      await persistAndLogin();
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  };

  if (step === "profile") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Set up your profile
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--nui-muted)" }}>
          Optional. You can fill these in later from any Nostr client.
        </p>

        <div className="nui-profile-fields">
          <span className="nui-profile-field-label">Display name</span>
          <input
            className="nui-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Satoshi"
            autoFocus
          />
        </div>

        <div className="nui-profile-fields">
          <span className="nui-profile-field-label">About</span>
          <input
            className="nui-input"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="Builder, chef, occasional cyclist."
          />
        </div>

        <div className="nui-profile-fields">
          <span className="nui-profile-field-label">Picture URL</span>
          <input
            className="nui-input"
            value={picture}
            onChange={(e) => setPicture(e.target.value)}
            placeholder="https://example.com/avatar.jpg"
            type="url"
          />
        </div>

        <button
          type="button"
          className="nui-login-button"
          onClick={() => void submitProfile(false)}
          disabled={publishing}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {publishing ? (
            <>
              Publishing <span className="nui-spinner" />
            </>
          ) : (
            "Save profile and continue"
          )}
        </button>
        <button
          type="button"
          className="nui-profile-skip"
          onClick={() => void submitProfile(true)}
          disabled={publishing}
        >
          Skip for now
        </button>
      </div>
    );
  }

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
        onClick={continueToNext}
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
