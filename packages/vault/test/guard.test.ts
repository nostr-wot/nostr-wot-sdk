/**
 * The persisted brute-force guard, and the auto-lock arithmetic.
 *
 * Both are pure functions on purpose: the vault owns the storage and the timer, and these
 * own the decisions, so the escalation table and the "is it time yet" question can be
 * tested without a clock, a store or a derivation.
 */
import { describe, test, expect } from 'vitest';
import {
  UNLOCK_FAILURES_PER_LOCKOUT,
  UNLOCK_LOCKOUT_STEPS_MS,
  guardLockoutRemaining,
  nextGuardState,
  type UnlockGuardState,
} from '../src/guard.js';
import { AUTO_LOCK_OPTIONS, shouldAutoLock } from '../src/autolock.js';
import { DEFAULT_AUTO_LOCK_MS } from '../src/constants.js';

const fresh = (): UnlockGuardState => ({ failures: 0, lockedUntil: 0 });

describe('the unlock guard', () => {
  test('five consecutive failures start an escalating lockout, and success clears it', () => {
    let state = fresh();
    for (let i = 0; i < 4; i++) state = nextGuardState(state, false, 1000);
    expect(state.lockedUntil).toBe(0);
    state = nextGuardState(state, false, 1000);
    expect(state.lockedUntil).toBe(1000 + 60_000);
    for (let i = 0; i < 5; i++) state = nextGuardState(state, false, 2000);
    expect(state.lockedUntil).toBe(2000 + 300_000);
    state = nextGuardState(state, true, 3000);
    expect(state).toEqual({ failures: 0, lockedUntil: 0 });
  });

  test('the step table matches the extension, and the last step is a cap, not a wrap', () => {
    expect(UNLOCK_LOCKOUT_STEPS_MS).toEqual([60_000, 300_000, 900_000, 1_800_000]);
    expect(UNLOCK_FAILURES_PER_LOCKOUT).toBe(5);

    let state = fresh();
    const lockouts: number[] = [];
    // Six full rounds: four to walk the table, two more to prove it stays on the last entry
    // rather than starting over at one minute — which is what an index that wrapped would do.
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < UNLOCK_FAILURES_PER_LOCKOUT; i++) state = nextGuardState(state, false, 0);
      lockouts.push(state.lockedUntil);
    }
    expect(lockouts).toEqual([60_000, 300_000, 900_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(state.failures).toBe(30);
  });

  test('a failure inside a round does not extend the lockout already running', () => {
    let state = fresh();
    for (let i = 0; i < 5; i++) state = nextGuardState(state, false, 1000);
    const lockedUntil = state.lockedUntil;
    // Attempts 6 through 9 are refused before any derivation, so they must not each buy the
    // attacker another minute: only crossing the next multiple of five moves the deadline.
    for (let i = 0; i < 4; i++) state = nextGuardState(state, false, 50_000);
    expect(state.lockedUntil).toBe(lockedUntil);
    expect(state.failures).toBe(9);
  });

  test('nextGuardState does not mutate the state it was given', () => {
    const state = fresh();
    const after = nextGuardState(state, false, 1000);
    expect(state).toEqual({ failures: 0, lockedUntil: 0 });
    expect(after).not.toBe(state);
  });

  test('the remaining lockout counts down and reaches zero', () => {
    const state: UnlockGuardState = { failures: 5, lockedUntil: 61_000 };
    expect(guardLockoutRemaining(state, 1000)).toBe(60_000);
    expect(guardLockoutRemaining(state, 60_999)).toBe(1);
    expect(guardLockoutRemaining(state, 61_000)).toBe(0);
    expect(guardLockoutRemaining(state, 999_999)).toBe(0);
    expect(guardLockoutRemaining(fresh(), 1000)).toBe(0);
  });
});

describe('auto-lock', () => {
  test('the vault stays open until the interval has fully elapsed', () => {
    expect(shouldAutoLock(1000, 60_000, 60_999)).toBe(false);
    expect(shouldAutoLock(1000, 60_000, 61_000)).toBe(true);
    expect(shouldAutoLock(1000, 60_000, 999_999)).toBe(true);
  });

  test('zero means never lock', () => {
    // The "never lock" vault is stored under the empty password and is meant to survive
    // any amount of idleness; a `0` read as "lock immediately" would lock it on every tick.
    expect(shouldAutoLock(0, 0, 999_999_999)).toBe(false);
    expect(shouldAutoLock(0, -1, 999_999_999)).toBe(false);
  });

  test('a clock that jumps backwards does not lock the vault', () => {
    expect(shouldAutoLock(10_000, 60_000, 0)).toBe(false);
  });

  test('the offered intervals are the extension\'s, with 15 minutes the default', () => {
    expect(AUTO_LOCK_OPTIONS.map((option) => option.ms)).toEqual([300_000, 900_000, 3_600_000, 0]);
    expect(DEFAULT_AUTO_LOCK_MS).toBe(900_000);
    expect(AUTO_LOCK_OPTIONS.some((option) => option.ms === DEFAULT_AUTO_LOCK_MS)).toBe(true);
  });
});
