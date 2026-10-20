/**
 * Auto-lock: the intervals a host can offer, and the one decision behind them.
 *
 * Ported from the browser extension's `AUTO_LOCK_OPTIONS` (`src/constants/vault.ts`) and the
 * `_autoLockTimer` logic in `src/services/vault/vault.ts`. The timer itself belongs to the
 * {@link Vault}; what lives here is pure, so a host that cannot hold a timer — a mobile app
 * that is suspended rather than ticking, a service worker torn down between requests — can
 * ask the same question on resume and get the same answer.
 */
import { DEFAULT_AUTO_LOCK_MS } from './constants.js';

/** One interval the security screen can offer. */
export interface AutoLockOption {
  /** Milliseconds of idleness before locking. 0 means never. */
  ms: number;
  /** Translation key for the label; this package ships no strings of its own. */
  labelKey: string;
}

/**
 * The intervals the extension offers, in its order.
 *
 * "Never" is last and is not a missing value: it stores the vault under the empty password
 * so the host can re-open it unattended. Moving into or out of that mode is a re-creation of
 * the vault under a different password, not a setting — see {@link Vault.setAutoLockMs}.
 */
export const AUTO_LOCK_OPTIONS: readonly AutoLockOption[] = [
  { ms: 300_000, labelKey: 'security.5min' },
  { ms: DEFAULT_AUTO_LOCK_MS, labelKey: 'security.15min' },
  { ms: 3_600_000, labelKey: 'security.1hr' },
  { ms: 0, labelKey: 'security.never' },
] as const;

/**
 * Has the vault been idle long enough to lock?
 *
 * `ms` of zero or less is "never lock" and is never due, whatever the clock says. The
 * comparison is `>=`, so an interval is over when it has fully elapsed and not a tick
 * before. A clock that has moved backwards — a device waking with a corrected time, a host
 * passing a monotonic reading from a different epoch — yields a negative idle time, which is
 * not due either: locking on a bad clock reading would throw away an open session for no
 * reason, and the next honest tick locks it anyway.
 */
export function shouldAutoLock(lastActivity: number, ms: number, now: number): boolean {
  if (ms <= 0) return false;
  return now - lastActivity >= ms;
}
