import { nip19 } from "nostr-tools";

/** Encode a 64-char hex pubkey as an npub string. */
export function hexToNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

/**
 * Decode an npub, nprofile, or bare hex pubkey to a hex pubkey.
 * Returns null if the input is not a recognisable format.
 */
export function npubToHex(input: string): string | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    /* not a valid nip19 string */
  }
  return null;
}

/**
 * Format a hex pubkey for display: `npub1abc...xyz`.
 * Shows the first 8 and last 4 chars of the npub encoding.
 */
export function formatPubkey(pubkey: string): string {
  const npub = hexToNpub(pubkey);
  return `${npub.slice(0, 8)}...${npub.slice(-4)}`;
}
