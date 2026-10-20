import type { Event, Filter } from "nostr-tools";
import { getPool, DEFAULT_TIMEOUT_MS } from "../pool";

/**
 * Subscribe to relays for `filter`. Resolve as soon as the first event
 * arrives, or when timeout expires. Used for single-event lookups (note
 * by id) where any one relay's response is sufficient.
 */
export function fastSingle(
  relays: string[],
  filter: Filter,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Event | null> {
  return new Promise((resolve) => {
    let result: Event | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sub.close(); } catch { /* noop */ }
      resolve(result);
    };
    const sub = getPool().subscribeMany(relays, filter, {
      onevent(event) {
        if (settled) return;
        result = event;
        finish();
      },
      oneose: () => finish(),
    });
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Subscribe to relays for `filter` and resolve with the newest event
 * received within the timeout. Used for replaceable kinds (kind 0, 3,
 * 10002) where we want the freshest copy across all responding relays.
 */
export function fastNewest(
  relays: string[],
  filter: Filter,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Event | null> {
  return new Promise((resolve) => {
    let newest: Event | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sub.close(); } catch { /* noop */ }
      resolve(newest);
    };
    const sub = getPool().subscribeMany(relays, filter, {
      onevent(event) {
        if (!newest || event.created_at > newest.created_at) newest = event;
      },
      oneose: () => finish(),
    });
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Subscribe and accumulate every distinct event seen within the timeout.
 * Used for "fetch all replies", "fetch all reactions", etc.
 *
 * `onEvent` is called for each new event as it arrives so callers can
 * stream into a UI (e.g. profile-cache pushes incremental updates as
 * each kind-0 lands).
 */
export function fastCollect(
  relays: string[],
  filter: Filter,
  options: { timeoutMs?: number; onEvent?: (e: Event) => void } = {},
): Promise<Event[]> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const seen = new Map<string, Event>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sub.close(); } catch { /* noop */ }
      resolve([...seen.values()]);
    };
    const sub = getPool().subscribeMany(relays, filter, {
      onevent(event) {
        if (seen.has(event.id)) return;
        seen.set(event.id, event);
        options.onEvent?.(event);
      },
      oneose: () => finish(),
    });
    setTimeout(finish, timeoutMs);
  });
}
