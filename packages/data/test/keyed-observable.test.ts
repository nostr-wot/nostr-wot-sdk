import { describe, expect, it, vi } from 'vitest';
import { createKeyedObservable } from '../src/cache/keyed-observable';

describe('keyed observable invalidation', () => {
  it('clears all slots before notifying and preserves both subscription kinds', () => {
    const store = createKeyedObservable<string, string>();
    store.set('alice', 'old profile');
    store.setStatus('bob', 'error', new Error('offline'));
    const empty = store.get('missing');
    const perKey = vi.fn(() => {
      expect(store.get('alice')).toBe(empty);
      expect(store.get('bob')).toBe(empty);
    });
    const unsubscribeKey = store.subscribe('alice', perKey);
    const all = vi.fn();
    const unsubscribeAll = store.subscribeAll(all);
    store.clear();
    expect(perKey).toHaveBeenCalledExactlyOnceWith(empty);
    expect(all.mock.calls).toEqual([['alice', empty], ['bob', empty]]);
    expect(empty).toEqual({ value: undefined, status: 'idle', lastFetched: 0 });

    perKey.mockImplementation(() => {});
    store.set('alice', 'new profile');
    expect(perKey).toHaveBeenCalledTimes(2);
    expect(perKey.mock.calls[1]).toEqual([store.get('alice')]);
    expect(all).toHaveBeenCalledTimes(3);
    unsubscribeKey(); unsubscribeAll();
    store.clear();
    store.set('alice', 'after unsubscribe');
    expect(perKey).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(3);
  });

  it('keeps subscriptions to keys that have no slot and makes empty clears quiet', () => {
    const store = createKeyedObservable<string, number>();
    const perKey = vi.fn(); const all = vi.fn();
    store.subscribe('future', perKey); store.subscribeAll(all);
    store.clear(); store.clear();
    expect(perKey).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
    store.set('future', 1);
    expect(perKey).toHaveBeenCalledExactlyOnceWith(store.get('future'));
    expect(all).toHaveBeenCalledExactlyOnceWith('future', store.get('future'));
  });

  it('allows a subscriber to repopulate after invalidation without losing that value', () => {
    const store = createKeyedObservable<string, number>();
    store.set('key', 1);
    store.subscribe('key', (slot) => {
      if (slot.status === 'idle') store.set('key', 2);
    });
    store.clear();
    expect(store.get('key').value).toBe(2);
  });

  it('retains the separate silent test reset that drops all subscriptions', () => {
    const store = createKeyedObservable<string, string>();
    store.set('key', 'value');
    const perKey = vi.fn(); const all = vi.fn();
    store.subscribe('key', perKey); store.subscribeAll(all);
    store._reset();
    expect(store.get('key').status).toBe('idle');
    store.set('key', 'next');
    expect(perKey).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
  });
});
