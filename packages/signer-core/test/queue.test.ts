/**
 * The pending map on its own: the caps, the timeout and the external rejections. The pipeline
 * tests cover the same behaviour through `SignerCore`; these pin the queue's own contract so a
 * refactor of the core cannot quietly change what counts toward a cap.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  ApprovalQueue,
  SignerError,
  MAX_IN_FLIGHT_GLOBAL,
  MAX_IN_FLIGHT_PER_ORIGIN,
  MAX_PENDING_PER_ORIGIN,
  REQUEST_TIMEOUT_MS,
  type PendingEntry,
} from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
});

const never = () => new Promise<never>(() => {});

function build(options: { onCancel?: (entry: PendingEntry, reason: string) => void } = {}) {
  const cancelled: Array<{ id: string; reason: string }> = [];
  const queue = new ApprovalQueue({
    onCancel: (entry, reason) => {
      cancelled.push({ id: entry.id, reason });
      options.onCancel?.(entry, reason);
    },
  });
  return { queue, cancelled };
}

let n = 0;
const entry = (
  kind: PendingEntry['kind'] = 'approval',
  origin = 'example.com',
  accountId: string | null = 'acct_1',
) => ({ id: `req_${++n}`, kind, origin, accountId });

describe('the per-origin cap', () => {
  test('counts actionable approvals only', async () => {
    const { queue } = build();
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) pending.push(queue.track(entry(), never));
    for (const promise of pending) promise.catch(() => {});
    await expect(queue.track(entry(), never)).rejects.toThrow(/too many/i);
    await expect(queue.track(entry(), never)).rejects.toMatchObject({ code: 'too_many_pending' });
    queue.dispose();
  });

  test('is per origin', async () => {
    const { queue } = build();
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) queue.track(entry(), never).catch(() => {});
    const other = queue.track(entry('approval', 'other.example'), never);
    other.catch(() => {});
    expect(queue.actionableCount('other.example')).toBe(1);
    queue.dispose();
  });

  test('unlock markers and remote entries do not count toward it', async () => {
    const { queue } = build();
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) {
      queue.track(entry('unlock'), never).catch(() => {});
      queue.track(entry('remote'), never).catch(() => {});
    }
    expect(queue.actionableCount('example.com')).toBe(0);
    expect(queue.pending()).toHaveLength(MAX_PENDING_PER_ORIGIN * 2);
    const approval = queue.track(entry(), never);
    approval.catch(() => {});
    expect(queue.actionableCount('example.com')).toBe(1);
    queue.dispose();
  });

  test('a settled entry no longer counts', async () => {
    const { queue } = build();
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) await queue.track(entry(), async () => i);
    expect(queue.actionableCount('example.com')).toBe(0);
    expect(queue.pending()).toHaveLength(0);
    const failed = queue.track(entry(), async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    expect(queue.pending()).toHaveLength(0);
  });
});

describe('the in-flight caps', () => {
  test('bound every kind per origin, markers included', async () => {
    const { queue } = build();
    for (let i = 0; i < MAX_IN_FLIGHT_PER_ORIGIN; i++) queue.track(entry('unlock'), never).catch(() => {});
    await expect(queue.track(entry('unlock'), never)).rejects.toThrow(/too many/i);
    const other = queue.track(entry('remote', 'other.example'), never);
    other.catch(() => {});
    expect(queue.pending()).toHaveLength(MAX_IN_FLIGHT_PER_ORIGIN + 1);
    queue.dispose();
  });

  test('bound every kind globally', async () => {
    const { queue } = build();
    for (let i = 0; i < MAX_IN_FLIGHT_GLOBAL; i++) {
      queue.track(entry('remote', `origin-${i}.example`), never).catch(() => {});
    }
    await expect(queue.track(entry('remote', 'one-more.example'), never)).rejects.toThrow(/too many/i);
    queue.dispose();
  });
});

describe('the timeout', () => {
  test('rejects an unanswered entry and reports the cancellation', async () => {
    vi.useFakeTimers();
    const { queue, cancelled } = build();
    const first = entry();
    const promise = queue.track(first, never);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(queue.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
    expect(cancelled).toEqual([{ id: first.id, reason: expect.stringMatching(/timed out/i) }]);
    expect(queue.pending()).toHaveLength(0);
  });

  test('aborts the signal handed to the work', async () => {
    vi.useFakeTimers();
    const { queue } = build();
    let signal: AbortSignal | undefined;
    const promise = queue.track(entry('remote'), (s) => {
      signal = s;
      return never();
    });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
  });

  test('is cleared when the work settles first', async () => {
    vi.useFakeTimers();
    const { queue, cancelled } = build();
    await queue.track(entry(), async () => 'done');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(cancelled).toHaveLength(0);
  });
});

describe('external rejection', () => {
  test('rejectPendingForAccount rejects only that account, with the reason given', async () => {
    const { queue, cancelled } = build();
    const mine = entry('approval', 'example.com', 'acct_1');
    const theirs = entry('approval', 'example.com', 'acct_2');
    const marker = entry('unlock', 'example.com', 'acct_1');
    const a = queue.track(mine, never);
    const b = queue.track(theirs, never);
    const c = queue.track(marker, never);
    for (const promise of [a, b, c]) promise.catch(() => {});
    expect(queue.rejectPendingForAccount('acct_1', 'Account switched')).toBe(2);
    await expect(a).rejects.toMatchObject({ code: 'account_switched', message: 'Account switched' });
    await expect(c).rejects.toMatchObject({ code: 'account_switched' });
    expect(queue.pending().map((e) => e.id)).toEqual([theirs.id]);
    expect(cancelled.map((c) => c.id).sort()).toEqual([mine.id, marker.id].sort());
    queue.dispose();
  });

  test('reject by id', async () => {
    const { queue } = build();
    const one = entry();
    const promise = queue.track(one, never);
    promise.catch(() => {});
    expect(queue.reject(one.id, 'Cancelled by user')).toBe(true);
    expect(queue.reject(one.id, 'Cancelled by user')).toBe(false);
    await expect(promise).rejects.toMatchObject({ code: 'rejected', message: 'Cancelled by user' });
  });

  test('a late result from rejected work is dropped', async () => {
    const { queue } = build();
    let finish: (value: string) => void = () => {};
    const promise = queue.track(entry(), () => new Promise<string>((resolve) => (finish = resolve)));
    promise.catch(() => {});
    queue.rejectPendingForAccount('acct_1', 'Account switched');
    finish('too late');
    await expect(promise).rejects.toThrow('Account switched');
  });

  test('dispose rejects everything and refuses new work', async () => {
    const { queue } = build();
    const promise = queue.track(entry(), never);
    promise.catch(() => {});
    queue.dispose();
    await expect(promise).rejects.toMatchObject({ code: 'shutdown' });
    await expect(queue.track(entry(), never)).rejects.toBeInstanceOf(SignerError);
    expect(queue.pending()).toHaveLength(0);
  });

  test('the same request id can be tracked once per phase, never twice in one', async () => {
    const { queue } = build();
    const one = entry();
    const a = queue.track(one, never);
    const b = queue.track({ ...one, kind: 'unlock' }, never);
    for (const promise of [a, b]) promise.catch(() => {});
    expect(queue.pending()).toHaveLength(2);
    await expect(queue.track(one, never)).rejects.toThrow(/already pending/i);
    queue.dispose();
  });
});
