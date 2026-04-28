/**
 * Historical inbox backfill. The live `subscribeInbox` only catches new
 * gift wraps; on first login or after a long offline period we need to
 * walk back through past wraps to discover existing partners + threads.
 *
 * Pattern lifted from obelisk's `loadInboxWindow` + partner-discovery
 * loop. Uses `sharedCoalescer.querySync` for one-shot, EOSE-bounded
 * fetches.
 */

import { sharedCoalescer } from "@nostr-wot/data";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import {
  KIND_GIFT_WRAP,
  KIND_NIP04_DM,
  decryptNip04,
  unwrapGiftWrap,
} from "../index";
import { ingestMessage } from "./store";
import type { DMMessage, DMSession } from "./types";

export interface BackfillOptions {
  /** Number of 30-day windows to walk back. Default 12 (≈1 year). */
  windows?: number;
  /** Per-window event ceiling per filter. Default 200. */
  limit?: number;
  /** Stop early once at least this many distinct partners are seen. */
  minPartners?: number;
  /** Override the inbox relay set used for the walk. */
  relays?: string[];
  /** Hard wallclock budget across all windows (ms). Default 30s. */
  timeoutMs?: number;
  /** Skip NIP-04 walk (only walk gift wraps). */
  nip17Only?: boolean;
}

export interface BackfillResult {
  /** Distinct partner pubkeys discovered (does not include `myPubkey`). */
  partners: string[];
  /** Total messages ingested (before dedup). */
  ingested: number;
  /** Number of windows actually walked before stop conditions hit. */
  windowsWalked: number;
}

/**
 * Walk past kind-4 + kind-1059 events in `windows` 30-day buckets,
 * decrypt each, ingest into the cache, and return the set of partners
 * seen. Designed for one-shot bootstrap, NOT live subscriptions.
 *
 * Stop conditions (whichever fires first):
 *   - `windows` buckets exhausted
 *   - `minPartners` distinct partners seen
 *   - `timeoutMs` budget expired
 *   - empty bucket (no events older than `until`) → assume nothing more
 */
export async function backfillInbox(
  session: DMSession,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const windows = opts.windows ?? 12;
  const limit = opts.limit ?? 200;
  const relays = opts.relays ?? session.relays;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minPartners = opts.minPartners ?? Infinity;

  const partners = new Set<string>();
  let ingested = 0;
  let until = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + timeoutMs;
  let walked = 0;

  for (let i = 0; i < windows; i++) {
    if (Date.now() >= deadline) break;
    if (partners.size >= minPartners) break;
    walked++;

    const since = until - 30 * 24 * 3600;
    const remaining = Math.max(1000, deadline - Date.now());
    const perFilterTimeout = Math.min(8000, remaining);

    const filters: Filter[] = [
      // NIP-17 inbound gift wraps
      { kinds: [KIND_GIFT_WRAP], "#p": [session.myPubkey], since, until, limit },
    ];
    if (!opts.nip17Only) {
      // NIP-04 inbound + outbound
      filters.push(
        { kinds: [KIND_NIP04_DM], "#p": [session.myPubkey], since, until, limit },
        { kinds: [KIND_NIP04_DM], authors: [session.myPubkey], since, until, limit },
      );
    }

    let events: NostrEvent[];
    try {
      events = await sharedCoalescer.querySync(filters, {
        relays,
        timeoutMs: perFilterTimeout,
      });
    } catch {
      events = [];
    }

    if (events.length === 0) break; // assume cold history past this point

    for (const e of events) {
      try {
        if (e.kind === KIND_NIP04_DM) {
          const plaintext = await decryptNip04(session.signer, e);
          const partner =
            e.pubkey === session.myPubkey
              ? e.tags.find((t: string[]) => t[0] === "p")?.[1]
              : e.pubkey;
          if (!partner) continue;
          const msg: DMMessage = {
            id: e.id,
            fromPubkey: e.pubkey,
            partnerPubkey: partner,
            content: plaintext,
            createdAt: e.created_at,
            scheme: "nip04",
            raw: e,
          };
          if (ingestMessage(session.myPubkey, msg)) {
            ingested++;
            partners.add(partner);
          }
        } else if (e.kind === KIND_GIFT_WRAP) {
          const { message, senderPubkey } = await unwrapGiftWrap(
            session.signer,
            e,
          );
          const partner =
            senderPubkey === session.myPubkey
              ? message.tags.find((t: string[]) => t[0] === "p")?.[1]
              : senderPubkey;
          if (!partner) continue;
          const msg: DMMessage = {
            id: message.id,
            fromPubkey: senderPubkey,
            partnerPubkey: partner,
            content: message.content,
            createdAt: message.created_at,
            scheme: "nip17",
            raw: e,
          };
          if (ingestMessage(session.myPubkey, msg)) {
            ingested++;
            partners.add(partner);
          }
        }
      } catch {
        /* per-event decrypt failures (different recipient, etc.); skip */
      }
    }

    until = since;
  }

  return { partners: Array.from(partners), ingested, windowsWalked: walked };
}
