'use client';

import { useEffect, useMemo, useState } from "react";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { sharedCoalescer } from "../coalescer";
import { getDefaultRelays } from "../pool";

export interface UseNostrQueryOptions {
  /** Relay set to query. Falls back to `getDefaultRelays()` when omitted. */
  relays?: string[];
  /** Hard ceiling on how long to wait for events. Default 8000 ms. */
  timeoutMs?: number;
  /** Skip the fetch entirely (e.g. while inputs are still null). */
  enabled?: boolean;
}

export interface UseNostrQueryResult {
  events: NostrEvent[];
  loading: boolean;
  error: Error | null;
}

/**
 * One-shot Nostr query as a React hook. Routes through `sharedCoalescer.querySync`
 * so it batches with concurrent live subscriptions and other one-shot queries
 * within the same debounce window. Re-fires when `filters` or `relays` change
 * (compared by JSON-stringified value, so callers don't need to memoize).
 *
 * Use this for "fetch this once when X changes" patterns (e.g. NIP-50 search,
 * ad-hoc filter lookups). For long-lived live subscriptions, use the
 * dedicated fetchers / hooks (`useProfile`, `useFollows`, …) or build a
 * thin wrapper around `sharedCoalescer.enqueue`.
 */
export function useNostrQuery(
  filters: Filter[],
  opts: UseNostrQueryOptions = {},
): UseNostrQueryResult {
  const { enabled = true, timeoutMs } = opts;
  const relays = useMemo(
    () => (opts.relays && opts.relays.length > 0 ? opts.relays : getDefaultRelays()),
    // Stringify caller-provided relays for stable dep tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(opts.relays ?? null)],
  );

  // Stable JSON dep so callers can pass fresh-array literals without
  // triggering an infinite refetch loop.
  const key = useMemo(
    () => JSON.stringify({ filters, relays, timeoutMs }),
    [filters, relays, timeoutMs],
  );

  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    sharedCoalescer
      .querySync(filters, { relays, timeoutMs })
      .then((result: NostrEvent[]) => {
        if (cancelled) return;
        setEvents(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `key` covers filters + relays + timeoutMs; relying on it keeps the
    // effect stable when callers pass fresh arrays each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { events, loading, error };
}
