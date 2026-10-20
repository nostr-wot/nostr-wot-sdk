import type { Event } from "nostr-tools";

/**
 * Parse the bolt11 invoice attached to a kind-9735 zap receipt and return
 * the amount in millisatoshis. Conservative: only handles the canonical
 * `lnbc<amount><multiplier>` prefix.
 *
 *   lnbc1m → 100,000,000 msat (1 mBTC = 100k sat)
 *   lnbc100u → 10,000,000 msat
 *   lnbc1000n → 100,000 msat
 *   lnbc100000p → 10,000 msat
 *
 * Returns 0 if the receipt has no bolt11 tag, the invoice prefix doesn't
 * parse, or the amount is non-finite.
 */
export function parseZapMsats(receipt: Event): number {
  const bolt11Tag = receipt.tags.find((t) => t[0] === "bolt11" && t[1]);
  if (!bolt11Tag || !bolt11Tag[1]) return 0;
  const inv = bolt11Tag[1].toLowerCase();
  const match = inv.match(/^lnbc(\d+)([munp]?)/);
  if (!match) return 0;
  const value = parseInt(match[1]!, 10);
  if (!Number.isFinite(value)) return 0;
  switch (match[2]) {
    case "m": return value * 100_000_000;
    case "u": return value * 100_000;
    case "n": return value * 100;
    case "p": return Math.floor(value / 10);
    default:  return value * 100_000_000_000;
  }
}
