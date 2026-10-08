"use client";

import { useState } from "react";
import { AnchorButton, Button } from "../../primitives/Button";

export interface Nip46ConnectionOptions {
  labels?: {
    openSigner?: string;
    pasteUri?: string;
    copyUri?: string;
    copied?: string;
    copyFailed?: string;
    fallbackHint?: string;
  };
  /** Customize platform handoff, for example an Android intent. The original URI is always copied. */
  signerHref?: (uri: string, userAgent: string) => string;
  /** Optional host clipboard adapter. Return false when copying is unavailable. */
  copyUri?: (uri: string) => Promise<boolean>;
  /** Copy the connection URI when following the signer link. Defaults to false. */
  copyOnOpen?: boolean;
}

async function copyConnectionUri(uri: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(uri);
  return true;
}

/** One native signer link and its clipboard fallback; remount when the pairing URI changes. */
export function Nip46ConnectionActions({ uri, options = {} }: { uri: string; options?: Nip46ConnectionOptions }) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const labels = options.labels;
  const copy = async () => {
    setCopyState("copying");
    try {
      setCopyState(await (options.copyUri ?? copyConnectionUri)(uri) ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  };
  const href = options.signerHref?.(uri, typeof navigator === "undefined" ? "" : navigator.userAgent) ?? uri;
  return (
    <>
      <AnchorButton
        variant="secondary"
        size="sm"
        fullWidth
        href={href}
        rel="noopener noreferrer"
        trailingIcon={<span aria-hidden>↗</span>}
        onClick={options.copyOnOpen ? () => { void copy(); } : undefined}
      >
        {labels?.openSigner ?? "Open in signer app"}
      </AnchorButton>
      <div className="nui-qr-actions">
        <Button variant="secondary" size="sm" fullWidth loading={copyState === "copying"} onClick={() => { void copy(); }}>
          {copyState === "copied" ? labels?.copied ?? "Copied" : copyState === "failed" ? labels?.copyFailed ?? "Could not copy" : labels?.copyUri ?? "Copy connect URI"}
        </Button>
        {labels?.fallbackHint && <p className="nui-signer-copy-hint">{labels.fallbackHint}</p>}
      </div>
    </>
  );
}
