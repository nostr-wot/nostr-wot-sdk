/**
 * The unlock brute-force guard.
 *
 * Ported from the browser extension's `readUnlockGuard` / `recordUnlockFailure` in
 * `src/services/background/vault-handlers.ts`, with the decision extracted into a pure
 * function so it can be reasoned about and tested without a store or a clock.
 *
 * The state is **persisted**, and that is the whole point. A UI-side lockout lives in the
 * page and resets on reload, so an attacker driving the unlock entry point directly — or a
 * user's own screen simply being reopened — starts from zero every time. Keeping the counter
 * in the store means repeated attempts hit a lockout regardless of what any caller does to
 * its own state. The vault resets it on a successful unlock and on destroy, and on nothing
 * else.
 */

/** How the guard remembers a run of failures. This shape is what goes into the store. */
export interface UnlockGuardState {
  /** Consecutive failed unlocks. Cleared by a success, never by time passing. */
  failures: number;
  /** Epoch milliseconds until which unlocking is refused. 0 when it is not. */
  lockedUntil: number;
}

/** Failures it takes to move to the next lockout step. */
export const UNLOCK_FAILURES_PER_LOCKOUT = 5;

/**
 * The escalation, one entry per five consecutive failures: 1 min, 5 min, 15 min, 30 min.
 *
 * The last entry is a cap rather than the end of a cycle — see {@link nextGuardState}. These
 * are the extension's numbers; a host showing a countdown should read them from here rather
 * than restate them, or the two drift and the UI lies about how long is left.
 */
export const UNLOCK_LOCKOUT_STEPS_MS: readonly number[] = [60_000, 300_000, 900_000, 1_800_000];

/** A guard that has never seen a failure. */
export function emptyGuardState(): UnlockGuardState {
  return { failures: 0, lockedUntil: 0 };
}

/**
 * The guard state after one unlock attempt.
 *
 * Pure: it neither reads the clock nor writes the store, so `now` is the caller's to supply
 * and the result is the caller's to persist.
 *
 * A success clears everything, including a lockout that is still running — the password was
 * right, so there is nothing left to throttle. A failure increments the counter, and every
 * time the counter crosses a multiple of {@link UNLOCK_FAILURES_PER_LOCKOUT} it starts the
 * next lockout, `Math.min`-clamped to the last step so that failure 25 and failure 2500 both
 * cost thirty minutes rather than wrapping back round to one.
 *
 * Failures *between* those multiples leave `lockedUntil` exactly where it was. They are
 * refused before any derivation happens, so charging each of them another minute would let a
 * caller extend its own lockout indefinitely by hammering a door that is already shut.
 */
export function nextGuardState(
  current: UnlockGuardState,
  success: boolean,
  now: number,
): UnlockGuardState {
  if (success) return emptyGuardState();

  const failures = current.failures + 1;
  if (failures % UNLOCK_FAILURES_PER_LOCKOUT !== 0) {
    return { failures, lockedUntil: current.lockedUntil };
  }
  const step = Math.min(
    failures / UNLOCK_FAILURES_PER_LOCKOUT - 1,
    UNLOCK_LOCKOUT_STEPS_MS.length - 1,
  );
  return { failures, lockedUntil: now + UNLOCK_LOCKOUT_STEPS_MS[step]! };
}

/**
 * Milliseconds left on the lockout, or 0 when there is none.
 *
 * The vault refuses to unlock while this is above zero; a host can show it as a countdown.
 */
export function guardLockoutRemaining(state: UnlockGuardState, now: number): number {
  return Math.max(0, state.lockedUntil - now);
}
