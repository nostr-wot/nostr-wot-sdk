/**
 * Inline NIP-98 challenge → sign → verify handshake against an
 * `@nostr-wot/auth` server endpoint.
 *
 * Inlined here (rather than depending on `@nostr-wot/auth/client`) so
 * `@nostr-wot/ui` doesn't pick up `@nostr-wot/auth` as a transitive
 * dep. The flow is small enough to duplicate cleanly.
 */

import type { EventTemplate } from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";

export async function performBackendAuth(
  baseUrl: string,
  signer: NostrSigner,
): Promise<void> {
  const challengeRes = await fetch(`${baseUrl}/challenge`, {
    method: "POST",
    credentials: "include",
  });
  if (!challengeRes.ok) {
    throw new Error(`Auth challenge failed: HTTP ${challengeRes.status}`);
  }
  const { challenge } = (await challengeRes.json()) as { challenge: string };

  const verifyUrl = `${baseUrl}/verify`;
  const template: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["u", verifyUrl],
      ["method", "POST"],
    ],
    content: "",
  };
  const event = await signer.signEvent(template);

  const verifyRes = await fetch(verifyUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  });
  if (!verifyRes.ok) {
    let msg = `Auth verify failed: HTTP ${verifyRes.status}`;
    try {
      const body = (await verifyRes.json()) as { error?: string; message?: string };
      if (body.error) msg = `Auth verify failed: ${body.error}`;
      if (body.message) msg += ` (${body.message})`;
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(msg);
  }
}
