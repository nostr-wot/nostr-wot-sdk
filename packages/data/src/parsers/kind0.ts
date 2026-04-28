import type { Event } from "nostr-tools";

export type ProfileEntry = {
  pubkey: string;
  displayName: string | null;
  name: string | null;
  picture: string | null;
  banner: string | null;
  about: string | null;
  nip05: string | null;
  lud16: string | null;
  fetchedAt: number;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

export function parseKind0(event: Event): ProfileEntry {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    pubkey: event.pubkey,
    displayName: str(parsed.display_name),
    name: str(parsed.name),
    picture: str(parsed.picture),
    banner: str(parsed.banner),
    about: str(parsed.about),
    nip05: str(parsed.nip05),
    lud16: str(parsed.lud16),
    fetchedAt: Date.now(),
  };
}
