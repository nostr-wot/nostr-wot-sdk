import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { NosskeyIframeSigner } from '../../src/signers/nosskey.js';
const key = new Uint8Array(32).fill(1),
  pubkey = getPublicKey(key);
let signer: NosskeyIframeSigner | undefined;
afterEach(() => {
  signer?.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const listeners = new Map<string, Function>();
  const sent: any[] = [];
  const peer = {
    postMessage: (data: any, origin: string) => sent.push({ data, origin }),
  };
  const iframe = {
    contentWindow: peer,
    style: {},
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    remove: vi.fn(),
    src: '',
  };
  const win = {
    addEventListener: (n: string, f: Function) => listeners.set(n, f),
    removeEventListener: (n: string) => listeners.delete(n),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement: () => iframe,
    body: { appendChild: vi.fn() },
  });
  signer = new NosskeyIframeSigner({
    iframeUrl: 'https://nosskey.example/#/iframe',
    timeoutMs: 100,
  });
  const receive = (
    data: any,
    origin = 'https://nosskey.example',
    source: any = peer,
  ) => listeners.get('message')?.({ data, origin, source });
  const respond = (result: any) =>
    receive({ type: 'nosskey:response', id: sent.at(-1).data.id, result });
  return { receive, respond, sent, iframe };
}
describe('Nosskey protocol signer', () => {
  it('pins source and origin and refuses a changed account', async () => {
    const { receive, respond, sent } = setup();
    receive({ type: 'nosskey:ready' });
    const first = signer!.getPublicKey();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent[0].origin).toBe('https://nosskey.example');
    receive(
      { type: 'nosskey:response', id: sent[0].data.id, result: 'bad' },
      'https://evil.example',
    );
    receive(
      { type: 'nosskey:response', id: sent[0].data.id, result: 'bad' },
      'https://nosskey.example',
      {},
    );
    respond(pubkey);
    expect(await first).toBe(pubkey);
    const second = signer!.getPublicKey();
    await Promise.resolve();
    await Promise.resolve();
    respond(getPublicKey(new Uint8Array(32).fill(2)));
    await expect(second).rejects.toThrow(/changed/);
  });
  it('rejects encryption if the provider changed accounts during the request', async () => {
    const { receive, respond, sent } = setup();
    receive({ type: 'nosskey:ready' });
    const pending = signer!.nip44Encrypt(pubkey, 'hello');
    const flush = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await flush();
    respond(pubkey);
    await flush();
    expect(sent.at(-1).data.method).toBe('nip44_encrypt');
    respond('ciphertext');
    await flush();
    expect(sent.at(-1).data.method).toBe('getPublicKey');
    respond(getPublicKey(new Uint8Array(32).fill(2)));
    await expect(pending).rejects.toThrow(/changed/);
  });
  it('bounds readiness and removes its frame on close', async () => {
    vi.useFakeTimers();
    const { iframe } = setup();
    const pending = signer!.ready();
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(iframe.remove).toHaveBeenCalled();
  });
  it('rejects a valid signature on different content', async () => {
    const { receive, respond } = setup();
    receive({ type: 'nosskey:ready' });
    const identity = signer!.getPublicKey();
    await Promise.resolve();
    await Promise.resolve();
    respond(pubkey);
    await identity;
    const template = { kind: 1, content: 'approved', created_at: 1, tags: [] };
    const pending = signer!.signEvent(template);
    await Promise.resolve();
    await Promise.resolve();
    respond(finalizeEvent({ ...template, content: 'changed' }, key));
    await expect(pending).rejects.toThrow(/match/);
  });
  it('rejects pending requests on disconnect', async () => {
    const { receive } = setup();
    receive({ type: 'nosskey:ready' });
    const pending = signer!.getPublicKey();
    await Promise.resolve();
    await Promise.resolve();
    signer!.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
  it('accepts a verified signature and closes on request timeout', async () => {
    const { receive, respond } = setup();
    receive({ type: 'nosskey:ready' });
    const identity = signer!.getPublicKey();
    await Promise.resolve();
    await Promise.resolve();
    respond(pubkey);
    await identity;
    const template = { kind: 1, content: 'approved', created_at: 1, tags: [] };
    const pending = signer!.signEvent(template);
    await Promise.resolve();
    await Promise.resolve();
    const event = finalizeEvent(template, key);
    respond(event);
    expect(await pending).toEqual(event);
    vi.useFakeTimers();
    const waiting = signer!.getPublicKey();
    const rejected = expect(waiting).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    await expect(signer!.ready()).rejects.toThrow(/closed/);
  });
});
