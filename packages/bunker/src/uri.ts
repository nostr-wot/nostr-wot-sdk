import { normalizeURL } from "nostr-tools/utils";
import type { NostrConnectUri } from "./types";

const HEX64 = /^[0-9a-f]{64}$/;
const NOSTRCONNECT = /^nostrconnect:\/\/([0-9a-fA-F]{64})\??(.*)$/;

/**
 * Build a `bunker://` URI. The query is encoded with `URLSearchParams`, which is
 * what `nostr-tools`' `parseBunkerInput` expects to decode.
 */
export function createBunkerUri(params: { pubkey: string; relays: string[]; secret?: string }): string {
  if (!HEX64.test(params.pubkey)) throw new Error("bunker URI: pubkey must be 64 hex chars");
  if (params.relays.length === 0) throw new Error("bunker URI: at least one relay is required");
  const qs = new URLSearchParams();
  for (const relay of normalizeRelays(params.relays)) qs.append("relay", relay);
  if (params.secret) qs.set("secret", params.secret);
  return `bunker://${params.pubkey}?${qs.toString()}`;
}

/**
 * Parse a client-generated `nostrconnect://` URI. Tolerates the empty
 * `image=&url=` placeholders some generators emit, and validates what the
 * responder actually depends on: a hex client pubkey, at least one relay and a
 * non-empty secret (NIP-46 requires it in this flow; the client checks our
 * `connect` response against it).
 */
export function parseNostrConnectUri(uri: string): NostrConnectUri {
  const match = uri.trim().match(NOSTRCONNECT);
  if (!match) throw new Error("nostrconnect URI: expected nostrconnect://<client-pubkey>?relay=...&secret=...");
  const clientPubkey = match[1].toLowerCase();
  const qs = new URLSearchParams(match[2]);
  // Relays are identified the way the pool identifies them, so two spellings of
  // one relay (case, trailing slash, default port) collapse to one entry.
  const relays: string[] = [];
  for (const raw of qs.getAll("relay")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let url: string;
    try {
      url = normalizeURL(trimmed);
    } catch {
      throw new Error("nostrconnect URI: invalid relay URL");
    }
    if (!relays.includes(url)) relays.push(url);
  }
  if (relays.length === 0) throw new Error("nostrconnect URI: at least one relay is required");
  const secret = (qs.get("secret") ?? "").trim();
  if (!secret) throw new Error("nostrconnect URI: secret is required");
  const perms = (qs.get("perms") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const optional = (key: string): string | undefined => {
    const value = qs.get(key)?.trim();
    return value ? value : undefined;
  };
  const out: NostrConnectUri = { clientPubkey, relays, secret, perms };
  const name = optional("name");
  const url = optional("url");
  const image = optional("image");
  if (name) out.name = name;
  if (url) out.url = url;
  if (image) out.image = image;
  return out;
}

/** Normalize and dedupe relay URLs with the pool's own rule, so our identity for a relay and its identity cannot disagree. */
export function normalizeRelays(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const url = normalizeURL(raw);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}
