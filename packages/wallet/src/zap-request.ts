import type { EventTemplate } from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";

/**
 * NIP-57 zap request (kind 9734).
 *
 * Flow:
 *   1. Caller looks up the recipient's lud16 (lightning address) and
 *      fetches their LNURL-pay endpoint.
 *   2. The endpoint advertises `allowsNostr: true` and a `nostrPubkey`.
 *   3. Caller builds a zap request event signed by the zapper, encodes
 *      it as a `nostr` query parameter on the LNURL callback, gets back
 *      a bolt11 invoice.
 *   4. Caller pays the invoice (via NWC, WebLN, or a wallet).
 *   5. The recipient receives a kind 9735 zap receipt published by the
 *      LNURL provider, containing the original zap request as a tag.
 */

export interface ZapRequestArgs {
  /** Recipient's hex pubkey. */
  recipientPubkey: string;
  /** Amount in millisatoshis. */
  amountMsats: number;
  /** Optional comment (zap note). */
  comment?: string;
  /** Relays where the recipient should look for the zap receipt. */
  relays: string[];
  /** Optional event id being zapped (zap a specific note). */
  eventId?: string;
  /** Optional addr/kind tags for replaceable events. */
  addrTag?: string;
}

/**
 * Build + sign a NIP-57 zap request event. Returns the signed event,
 * which the caller appends to the LNURL callback as `nostr=...`.
 *
 * Validates two NIP-57 requirements that the spec calls out explicitly:
 *   - `relays` must be non-empty (the LNURL provider needs at least one
 *     relay to publish the kind 9735 receipt to).
 *   - `amountMsats` must be a positive integer.
 */
export async function buildZapRequest(
  signer: NostrSigner,
  args: ZapRequestArgs,
): Promise<{ event: import("nostr-tools").Event; encoded: string }> {
  if (!Number.isFinite(args.amountMsats) || args.amountMsats <= 0) {
    throw new Error("amountMsats must be a positive number");
  }
  if (!args.relays || args.relays.length === 0) {
    throw new Error("relays must not be empty (NIP-57 requires at least one relay)");
  }

  const tags: string[][] = [
    ["p", args.recipientPubkey],
    ["amount", String(args.amountMsats)],
    ["relays", ...args.relays],
  ];
  if (args.eventId) tags.push(["e", args.eventId]);
  if (args.addrTag) tags.push(["a", args.addrTag]);

  const template: EventTemplate = {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.comment ?? "",
  };
  const event = await signer.signEvent(template);
  const encoded = encodeURIComponent(JSON.stringify(event));
  return { event, encoded };
}

/**
 * Resolve a lightning address (`name@domain.com`) to its LNURL-pay
 * metadata. Returns null if the address is unreachable or doesn't
 * support Nostr zaps.
 */
export async function fetchLnurlPayMetadata(
  lud16: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  allowsNostr: boolean;
  nostrPubkey?: string;
} | null> {
  const [name, domain] = lud16.split("@");
  if (!name || !domain) return null;
  const url = `https://${domain}/.well-known/lnurlp/${name}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data as ReturnType<typeof fetchLnurlPayMetadata> extends Promise<infer T> ? T : never;
  } catch {
    return null;
  }
}

/**
 * Full zap pipeline: lud16 → LNURL → invoice. Caller pays the returned
 * `pr` (bolt11 invoice) via their wallet.
 */
export async function requestZapInvoice(
  signer: NostrSigner,
  options: ZapRequestArgs & { lud16: string; fetchImpl?: typeof fetch },
): Promise<{ invoice: string; zapRequest: import("nostr-tools").Event }> {
  const lnurl = await fetchLnurlPayMetadata(options.lud16, options.fetchImpl);
  if (!lnurl) throw new Error(`Could not resolve LNURL-pay for ${options.lud16}`);
  if (!lnurl.allowsNostr) throw new Error(`${options.lud16} does not accept Nostr zaps`);

  const { event, encoded } = await buildZapRequest(signer, options);
  const callback = new URL(lnurl.callback);
  callback.searchParams.set("amount", String(options.amountMsats));
  callback.searchParams.set("nostr", encoded);
  if (options.comment) callback.searchParams.set("comment", options.comment);

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(callback.toString());
  if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`);
  const body = await res.json();
  if (!body.pr) throw new Error("LNURL callback did not return an invoice");
  return { invoice: body.pr as string, zapRequest: event };
}
