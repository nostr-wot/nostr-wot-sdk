import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pools: [] as any[], signers: [] as any[], connect: vi.fn(), fromURI: vi.fn() }));
vi.mock('nostr-tools', async (original) => {
  const actual = await original<typeof import('nostr-tools')>();
  return { ...actual, SimplePool: class {
    destroyed = vi.fn();
    destroy() { this.destroyed(); }
    ensureRelay() { return new Promise(() => {}); }
    constructor(readonly options: any) { mocks.pools.push(this); }
  } };
});
vi.mock('nostr-tools/nip46', () => ({
  parseBunkerInput: async () => ({ pubkey: 'a'.repeat(64), relays: ['wss://relay.example'] }),
  createNostrConnectURI: () => 'nostrconnect://test',
  BunkerSigner: {
    fromBunker: () => {
      const signer = { close: vi.fn().mockResolvedValue(undefined), connect: mocks.connect };
      mocks.signers.push(signer);
      return signer;
    },
    fromURI: mocks.fromURI,
  },
}));
import { Nip46Signer } from '../src/nip46';
import { Nip46Connection } from '../src/nip46/connection';
import { SimplePool } from 'nostr-tools';

beforeEach(() => {
  mocks.pools.length = 0;
  mocks.signers.length = 0;
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.fromURI.mockReset();
  vi.stubGlobal('WebSocket', class extends EventTarget {
    readyState = 0;
    close = vi.fn();
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('destroys an internally owned pool and closes the signer only once', async () => {
  const signer = await Nip46Signer.fromBunkerUri('bunker://test');
  await signer.close();
  await signer.close();
  expect(mocks.pools[0].destroyed).toHaveBeenCalledOnce();
  expect(mocks.signers[0].close).toHaveBeenCalledOnce();
});

it('releases the internally owned transport after a failed bunker handshake', async () => {
  mocks.connect.mockRejectedValue(new Error('denied'));
  await expect(Nip46Signer.fromBunkerUri('bunker://test')).rejects.toThrow('denied');
  expect(mocks.pools[0].destroyed).toHaveBeenCalledOnce();
  expect(mocks.signers[0].close).toHaveBeenCalledOnce();
});

it('leaves caller-owned pool sockets intact on success and failure', async () => {
  const pool = new SimplePool();
  const signer = await Nip46Signer.fromBunkerUri('bunker://test', { pool });
  await signer.close();
  mocks.connect.mockRejectedValue(new Error('denied'));
  await expect(Nip46Signer.fromBunkerUri('bunker://test', { pool })).rejects.toThrow('denied');
  expect((pool as any).destroyed).not.toHaveBeenCalled();
});

it.each(['cancel', 'timeout'])('destroys pairing transport on %s even before fromURI settles', async (mode) => {
  vi.useFakeTimers();
  mocks.fromURI.mockImplementation((_sk, _uri, _params, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const handle = Nip46Signer.startNostrConnect({ relays: ['wss://relay.example'], pairTimeoutMs: 20 });
  const assertion = expect(handle.ready).rejects.toThrow(mode === 'timeout' ? 'timed out' : 'aborted');
  if (mode === 'cancel') handle.cancel();
  else await vi.advanceTimersByTimeAsync(20);
  await assertion;
  expect(mocks.pools[0].destroyed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('closes a signer returned after pairing was cancelled', async () => {
  let resolve!: (signer: any) => void;
  mocks.fromURI.mockImplementation(() => new Promise(r => { resolve = r; }));
  const handle = Nip46Signer.startNostrConnect({ relays: ['wss://relay.example'] });
  handle.cancel();
  const late = { close: vi.fn().mockResolvedValue(undefined) };
  resolve(late);
  await expect(handle.ready).rejects.toThrow('disposed');
  expect(late.close).toHaveBeenCalledOnce();
});

it('closes connecting sockets, rejects pending relay waits and suppresses late opens', async () => {
  const connection = new Nip46Connection();
  const Socket = mocks.pools[0].options.websocketImplementation;
  const socket = new Socket('wss://relay.example');
  const opened = vi.fn();
  socket.addEventListener('open', opened);
  const pending = connection.pool.ensureRelay('wss://relay.example');
  connection.dispose();
  await expect(pending).rejects.toThrow('disposed');
  expect(socket.close).toHaveBeenCalledOnce();
  socket.readyState = 1;
  socket.dispatchEvent(new Event('open'));
  expect(socket.close).toHaveBeenCalledTimes(2);
  expect(opened).not.toHaveBeenCalled();
  expect(() => new Socket('wss://relay.example')).toThrow('disposed');
  await expect(connection.pool.ensureRelay('wss://relay.example')).rejects.toThrow('disposed');
});
