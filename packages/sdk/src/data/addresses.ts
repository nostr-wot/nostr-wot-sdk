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

/**
 * Decode an `nsec1…` private key into its raw bytes. Returns null when the
 * input isn't a valid nsec.
 */
export function nsecToBytes(nsec: string): Uint8Array | null {
  try {
    const decoded = nip19.decode(nsec.trim());
    if (decoded.type === "nsec") return decoded.data as Uint8Array;
  } catch {
    /* not a valid nsec */
  }
  return null;
}

/** Decode an `nsec1…` private key into a 64-char lowercase hex string. */
export function nsecToHex(nsec: string): string | null {
  const bytes = nsecToBytes(nsec);
  if (!bytes) return null;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a short, user-friendly fallback label for a hex pubkey:
 * `npub1abcd…` (first 11 chars + ellipsis). Falls back to the hex prefix
 * if encoding fails (e.g. malformed pubkey).
 */
export function shortNpub(pubkeyHex: string): string {
  try {
    const npub = nip19.npubEncode(pubkeyHex);
    return `${npub.slice(0, 11)}…`;
  } catch {
    return `${pubkeyHex.slice(0, 8)}…`;
  }
}

/**
 * Extract the unique set of mentioned hex pubkeys from a string. Recognises
 * both forms commonly found in message content:
 *   - the legacy hex form `nostr:npub1<64 hex>` produced by some clients
 *   - real NIP-19 bech32 `nostr:npub1<bech32>` / raw `npub1<bech32>`.
 *
 * Order of returned pubkeys follows the order of first occurrence.
 */
export function extractMentionPubkeys(content: string): string[] {
  const found = new Set<string>();
  const re = /(?:nostr:)?npub1([a-z0-9]{58,90})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const body = match[1];
    if (!body) continue;
    if (/^[a-f0-9]{64}$/i.test(body)) {
      found.add(body.toLowerCase());
      continue;
    }
    try {
      const decoded = nip19.decode(`npub1${body}`);
      if (decoded.type === "npub") found.add(decoded.data as string);
    } catch {
      /* not a valid npub — ignore */
    }
  }
  return [...found];
}

/**
 * One occurrence of an `npub` mention inside a string. `start` / `end` are
 * character offsets so callers can splice the original content into
 * text/mention segments without re-scanning.
 */
export interface NpubMentionMatch {
  /** Hex pubkey (lowercase). */
  pubkey: string;
  /** The exact substring that matched (e.g. `nostr:npub1abc…` or `npub1abc…`). */
  raw: string;
  /** Inclusive start offset in the source string. */
  start: number;
  /** Exclusive end offset in the source string (`start + raw.length`). */
  end: number;
}

/**
 * Locate every `npub` mention in `content` and return their positions +
 * decoded hex pubkey. Useful when callers need to split message content
 * into text / mention segments while keeping the original substring around.
 */
export function findNpubMentions(content: string): NpubMentionMatch[] {
  const out: NpubMentionMatch[] = [];
  const re = /(?:nostr:)?npub1([a-z0-9]{58,90})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const raw = match[0];
    const body = match[1];
    if (!body) continue;
    let pubkey: string | null = null;
    if (/^[a-f0-9]{64}$/i.test(body)) {
      pubkey = body.toLowerCase();
    } else {
      try {
        const decoded = nip19.decode(`npub1${body}`);
        if (decoded.type === "npub") pubkey = decoded.data as string;
      } catch {
        /* skip */
      }
    }
    if (!pubkey) continue;
    out.push({ pubkey, raw, start: match.index, end: match.index + raw.length });
  }
  return out;
}
