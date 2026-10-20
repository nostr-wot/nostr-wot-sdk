import { afterEach, expect, it, vi } from 'vitest';
import { A, advance, flush, makeHub, makeSigner, sessionIdentity, type TestHub } from './test-support';
let t: TestHub;
afterEach(() => { t?.hub.dispose(); vi.useRealTimers(); });

it('puts hundreds of one-shot queries and live subscriptions under one socket budget', async () => {
  vi.useFakeTimers();
  t = makeHub({ maxSubsPerSocket: 4 });
  t.hub.setIdentity(sessionIdentity(makeSigner()));
  const live = t.hub.subscribe({ relays: [A], filters: [{ kinds: [1] }], priority: 'voice', onEvent() {} });
  const queries = Array.from({ length: 200 }, (_, i) => t.hub.query({ relays: [A], filters: [{ kinds: [0], authors: [String(i)] }], maxWaitMs: 1000 }));
  await flush();
  const relay = t.factory.get(A)!;
  expect(relay.openSubs().length).toBeLessThanOrEqual(4);
  expect(relay.reqLog.length).toBeLessThanOrEqual(4);
  await advance(1000);
  await Promise.all(queries);
  expect(relay.reqLog.length).toBeLessThanOrEqual(4);
  expect(relay.openSubs()).toHaveLength(1);
  live.release();
});

it('does not immediately replace a quota-closed REQ when its caller releases it', async () => {
  vi.useFakeTimers();
  t = makeHub({ maxSubsPerSocket: 2 });
  t.hub.setIdentity(sessionIdentity(makeSigner()));
  const handles: Array<{ release(): void }> = [];
  for (let i = 0; i < 100; i++) {
    const handle = t.hub.subscribe({ relays: [A], filters: [{ kinds: [i] }], onEvent() {},
      onRelayClosed: () => handle.release() });
    handles.push(handle);
  }
  await flush();
  const relay = t.factory.get(A)!;
  const before = relay.reqLog.length;
  for (const sub of relay.openSubs()) relay.closed(sub.id, 'restricted: subscription quota exceeded');
  await flush();
  expect(relay.reqLog.length).toBe(before);
  await advance(59_999);
  expect(relay.reqLog.length).toBe(before);
  for (const handle of handles) handle.release();
});


it('keeps one-shot query lifetime separate from an identical live subscription', async () => {
  vi.useFakeTimers();
  t = makeHub({ maxSubsPerSocket: 4 });
  t.hub.setIdentity(sessionIdentity(makeSigner()));
  const filters = [{ kinds: [1] }];
  const live = t.hub.subscribe({ relays: [A], filters, onEvent() {} });
  await flush();
  const relay = t.factory.get(A)!;
  relay.eose();
  const query = t.hub.query({ relays: [A], filters });
  await flush();
  expect(relay.openSubs()).toHaveLength(2);
  relay.eose();
  expect((await query).complete).toBe(true);
  expect(relay.openSubs()).toHaveLength(1);
  live.release();
});
