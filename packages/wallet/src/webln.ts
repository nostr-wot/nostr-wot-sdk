// packages/wallet/src/webln.ts
// Generic NIP-57 + WebLN zap helper. Resolves a Lightning Address (lud16),
// builds a signed kind 9734 zap-request event, fetches a BOLT11 invoice from
// the LNURL callback (with `nostr=<encoded zap request>`), and pays it via
// `window.webln`.
//
// Why this lives in the SDK: WebLN is the lowest-friction zap path that
// doesn't require NWC provisioning — any user with Alby (or another WebLN
// extension) can zap immediately. The flow is pure NIP-57 plumbing with no
// app-specific state, so reusing it across nostr-wot apps is trivial.

import type { NostrSigner } from "@nostr-wot/signers";
import { buildZapRequest, fetchLnurlPayMetadata } from "./zap-request";

interface WebLNProvider {
  enable(): Promise<void>;
  sendPayment(invoice: string): Promise<{ preimage: string }>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    webln?: WebLNProvider;
  }
}

export function isWebLNAvailable(): boolean {
  return typeof window !== "undefined" && !!window.webln;
}

export interface WebLNZapOptions {
  signer: NostrSigner;
  recipientPubkey: string;
  /** Recipient Lightning Address (lud16, e.g. `alice@example.com`). */
  recipientLud16: string;
  /** Optional event id being zapped — omit to send a user-zap (no `e` tag). */
  eventId?: string;
  /** Amount in sats. Converted to msats internally. */
  amountSats: number;
  /** Relays to include in the zap-request `relays` tag. Defaults applied if empty. */
  relays: string[];
  /** Optional comment included both in the zap-request content and as LNURL `comment`. */
  comment?: string;
  /** Optional `fetch` override — useful for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Send a zap to `recipientLud16` for `amountSats` via WebLN.
 *
 * Throws if WebLN is unavailable, the lud16 doesn't accept Nostr zaps, or
 * the amount is outside the LNURL provider's `min/maxSendable` window.
 */
export async function zapViaWebLN(opts: WebLNZapOptions): Promise<{ preimage: string }> {
  if (!isWebLNAvailable()) throw new Error("No WebLN extension found (try Alby).");
  const webln = window.webln!;
  await webln.enable();

  const fetchImpl = opts.fetchImpl ?? fetch;
  const lnurl = await fetchLnurlPayMetadata(opts.recipientLud16, fetchImpl);
  if (!lnurl) throw new Error(`Could not resolve LNURL-pay for ${opts.recipientLud16}`);
  if (!lnurl.allowsNostr) throw new Error(`${opts.recipientLud16} does not accept Nostr zaps`);

  const amountMsats = opts.amountSats * 1000;
  if (amountMsats < lnurl.minSendable || amountMsats > lnurl.maxSendable) {
    throw new Error(
      `Amount out of range (${Math.ceil(lnurl.minSendable / 1000)}–${Math.floor(lnurl.maxSendable / 1000)} sats).`,
    );
  }

  const relays = opts.relays.length > 0 ? opts.relays : ["wss://relay.damus.io", "wss://nos.lol"];
  const { event, encoded } = await buildZapRequest(opts.signer, {
    recipientPubkey: opts.recipientPubkey,
    amountMsats,
    relays,
    eventId: opts.eventId,
    comment: opts.comment,
  });

  const callback = new URL(lnurl.callback);
  callback.searchParams.set("amount", String(amountMsats));
  callback.searchParams.set("nostr", encoded);
  if (opts.comment) callback.searchParams.set("comment", opts.comment);

  const res = await fetchImpl(callback.toString());
  if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`);
  const body = (await res.json()) as { pr?: string; reason?: string };
  if (!body.pr) throw new Error(body.reason ?? "LNURL callback did not return an invoice");

  // Touch `event` so users have a chance to inspect it via the return value
  // if needed (currently we just pay and forget — receipts come back via
  // useZapReceipts).
  void event;

  return webln.sendPayment(body.pr);
}
