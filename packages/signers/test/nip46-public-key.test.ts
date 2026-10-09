import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readPublicKeyWithRetry } from '../src/nip46/public-key';
const pubkey = 'a'.repeat(64);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('retries a lost read and stops when any request answers', async () => {
  const request = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(pubkey);
  const result = readPublicKeyWithRetry(request, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toBe(pubkey);
  await vi.advanceTimersByTimeAsync(20000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it('accepts a late answer to the first request after issuing a retry', async () => {
  let answer!: (key: string) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { answer = resolve; })).mockImplementation(() => new Promise(() => {}));
  const result = readPublicKeyWithRetry(request, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  answer(pubkey);
  expect(await result).toBe(pubkey);
  expect(vi.getTimerCount()).toBe(0);
});
it('times out with at most three requests instead of waiting forever', async () => {
  const request = vi.fn(() => new Promise<string>(() => {}));
  const result = readPublicKeyWithRetry(request, new AbortController().signal);
  const assertion = expect(result).rejects.toThrow('did not answer get_public_key');
  await vi.advanceTimersByTimeAsync(12000);
  await assertion;
  expect(request).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending reads and timers when the signer closes', async () => {
  const controller = new AbortController();
  const request = vi.fn(() => new Promise<string>(() => {}));
  const result = readPublicKeyWithRetry(request, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow('cancelled');
  await vi.advanceTimersByTimeAsync(20000);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not retry a signer rejection or accept an invalid identity', async () => {
  const request = vi.fn().mockRejectedValue(new Error('permission denied'));
  await expect(readPublicKeyWithRetry(request, new AbortController().signal)).rejects.toThrow('permission denied');
  await vi.advanceTimersByTimeAsync(20000);
  expect(request).toHaveBeenCalledOnce();
  await expect(readPublicKeyWithRetry(async () => 'ack', new AbortController().signal)).rejects.toThrow('invalid public key');
});
