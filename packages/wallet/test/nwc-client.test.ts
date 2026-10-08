/**
 * The NIP-47 client on its own, over a transport made straight from one
 * fake relay (no hub): encryption choice, answers, wallet errors, timeouts,
 * and what each failure promises about money.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { FakeRelayFactory, type FakeRelay } from '@nostr-wot/relay/hub';
import { NWC_KINDS, NwcClient, NwcError, mayHavePaid, parseNwcUri, type NwcTransport } from '../src/nwc/index';
import { FakeNwcWallet, type FakeWalletOptions } from './support/fake-nwc-wallet';

const IDENTITY = { id: 'nwc:test', pubkey: null, signer: null, authPolicy: 'never-auth' as const };

function relayTransport(relay: FakeRelay, opts: { publishFails?: boolean } = {}): NwcTransport {
  return {
    subscribe(filter: Filter, h) {
      const sub = relay.subscribe([filter], { onevent: h.onEvent, oneose: h.onReady });
      return { close: () => sub.close() };
    },
    publish: (event: NostrEvent) => (opts.publishFails ? Promise.resolve(false) : relay.publish(event).then(() => true, () => false)),
    query: (filter: Filter) => new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const sub = relay.subscribe([filter], {
        onevent: (e) => events.push(e),
        oneose: () => { sub.close(); resolve(events); },
      });
    }),
  };
}

async function setup(walletOpts: FakeWalletOptions = {}, transportOpts: { publishFails?: boolean } = {}) {
  const wallet = new FakeNwcWallet(walletOpts);
  const relay = wallet.attach(new FakeRelayFactory())(wallet.relayUrl, IDENTITY);
  await relay.connect();
  const client = new NwcClient(parseNwcUri(wallet.uri), relayTransport(relay, transportOpts), {
    infoMs: 1_000, readyMs: 500, payMs: 5_000, callMs: 1_000,
  });
  return { wallet, relay, client };
}

async function rejection(promise: Promise<unknown>): Promise<NwcError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(NwcError);
    return e as NwcError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NwcClient', () => {
  it('pays an invoice in NIP-44 when the wallet offers it, signed by the client key, with an expiration', async () => {
    const { wallet, client } = await setup();
    const paid = await client.payInvoice('lnbc1invoice');

    expect(paid.preimage).toBe('ab'.repeat(32));
    const [req] = wallet.calls('pay_invoice');
    expect(req.params).toEqual({ invoice: 'lnbc1invoice' });
    expect(req.encryption).toBe('nip44_v2');
    expect(req.event.pubkey).toBe(wallet.clientPubkey);
    expect(req.event.tags).toContainEqual(['p', wallet.walletPubkey]);
    const expiration = Number(req.event.tags.find((t) => t[0] === 'expiration')?.[1]);
    expect(expiration).toBeGreaterThan(req.event.created_at);
  });

  it('speaks NIP-04 to a wallet whose info event names no encryption', async () => {
    const { wallet, client } = await setup({ encryption: null });
    await client.payInvoice('lnbc1invoice');
    expect(wallet.calls('pay_invoice')[0].encryption).toBe('nip04');
    expect(wallet.calls('pay_invoice')[0].event.tags.some((t) => t[0] === 'encryption')).toBe(false);
  });

  it('reads the alias and the budget only when the connection may ask for them', async () => {
    const { client } = await setup();
    expect(await client.walletAlias()).toBe('Test Wallet');
    expect(await client.budget()).toEqual({ usedMsats: 21_000, totalMsats: 100_000, renewsAt: null, renewalPeriod: 'monthly' });

    const limited = await setup({ methods: 'pay_invoice' });
    expect(await limited.client.walletAlias()).toBeNull();
    expect(await limited.client.budget()).toBeNull();
    expect(limited.wallet.requests).toEqual([]);
  });

  it('turns a wallet error into our code, and says nothing was paid', async () => {
    const { wallet, client } = await setup();
    wallet.respond = () => ({ error: { code: 'INSUFFICIENT_BALANCE', message: 'broke' } });
    const err = await rejection(client.payInvoice('lnbc1invoice'));
    expect(err.code).toBe('wallet-insufficient-balance');
    expect(err.walletCode).toBe('INSUFFICIENT_BALANCE');
    expect(err.outcome).toBe('not-paid');
    expect(mayHavePaid(err)).toBe(false);
  });

  it('times out a silent wallet as "may have paid"', async () => {
    const { wallet, client } = await setup();
    wallet.respond = () => 'silent';
    vi.useFakeTimers();
    const pending = rejection(client.payInvoice('lnbc1invoice'));
    await vi.advanceTimersByTimeAsync(5_001);
    const err = await pending;
    expect(err.code).toBe('wallet-timeout');
    expect(mayHavePaid(err)).toBe(true);
    expect(wallet.calls('pay_invoice')).toHaveLength(1);
  });

  it('reports a request no relay took as not paid', async () => {
    const { wallet, client } = await setup({}, { publishFails: true });
    const err = await rejection(client.payInvoice('lnbc1invoice'));
    expect(err.code).toBe('wallet-relay-failed');
    expect(err.outcome).toBe('not-paid');
    expect(wallet.requests).toEqual([]);
  });

  it('refuses a wallet with no info event, and a connection that may not pay', async () => {
    expect((await rejection((await setup({ noInfo: true })).client.payInvoice('lnbc1'))).code).toBe('nwc-unreachable');
    const noPay = await setup({ methods: 'get_info get_balance' });
    expect((await rejection(noPay.client.payInvoice('lnbc1'))).code).toBe('nwc-cannot-pay');
    expect(noPay.wallet.requests).toEqual([]);
  });

  it('ignores an answer to another request and an answer from another key', async () => {
    const { wallet, relay, client } = await setup();
    wallet.respond = () => 'silent';
    vi.useFakeTimers();
    const pending = rejection(client.payInvoice('lnbc1invoice'));
    await vi.advanceTimersByTimeAsync(10);
    const req = wallet.calls('pay_invoice')[0].event;
    const { finalizeEvent, generateSecretKey } = await import('nostr-tools/pure');
    // Signed by a stranger, tagged as the answer: must not settle the call.
    relay.emit(finalizeEvent({ kind: NWC_KINDS.response, created_at: req.created_at, tags: [['p', wallet.clientPubkey], ['e', req.id]], content: 'x' }, generateSecretKey()));
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).code).toBe('wallet-timeout');
  });
});

describe('NIP-47 transport and response boundaries', () => {
  it('times out an unresolved publish as an unknown outcome', async () => {
    const { wallet, relay, client: original } = await setup();
    const transport = relayTransport(relay);
    transport.publish = () => new Promise(() => {});
    const client = new NwcClient(original.connection, transport, { infoMs: 100, readyMs: 10, payMs: 100, callMs: 100 });
    vi.useFakeTimers();
    const pending = rejection(client.payInvoice('lnbc1'));
    await vi.advanceTimersByTimeAsync(101);
    expect(mayHavePaid(await pending)).toBe(true);
    expect(wallet.requests).toEqual([]);
  });

  it('cleans up a failed subscription without ever publishing', async () => {
    const { relay, client: original } = await setup();
    const transport = relayTransport(relay);
    transport.subscribe = () => { throw new Error('offline'); };
    transport.publish = vi.fn();
    const client = new NwcClient(original.connection, transport, { infoMs: 100, readyMs: 10, payMs: 100, callMs: 100 });
    vi.useFakeTimers();
    const failed = await rejection(client.payInvoice('lnbc1'));
    expect(failed.outcome).toBe('not-paid');
    await vi.advanceTimersByTimeAsync(101);
    expect(transport.publish).not.toHaveBeenCalled();
  });

  it.each(['null', '{"result_type":"get_info","result":{}}', '{"result_type":"pay_invoice"}', '{"result_type":"pay_invoice","error":{}}', '{"result_type":"pay_invoice","error":"oops"}', '{"result_type":"pay_invoice","result":{}}'])('rejects a malformed signed reply as unknown: %s', async (plaintext) => {
    const { wallet, relay, client } = await setup();
    wallet.respond = () => 'silent';
    vi.useFakeTimers();
    const pending = rejection(client.payInvoice('lnbc1'));
    await vi.advanceTimersByTimeAsync(10);
    const request = wallet.calls('pay_invoice')[0].event;
    const { finalizeEvent } = await import('nostr-tools/pure');
    const { v2 } = await import('nostr-tools/nip44');
    relay.emit(finalizeEvent({
      kind: NWC_KINDS.response, created_at: request.created_at,
      tags: [['p', wallet.clientPubkey], ['e', request.id]],
      content: v2.encrypt(plaintext, v2.utils.getConversationKey(wallet.walletSecret, wallet.clientPubkey)),
    }, wallet.walletSecret));
    expect((await pending).outcome).toBe('unknown');
  });

  it('ignores a response whose claimed wallet signature is invalid', async () => {
    const { wallet, relay, client } = await setup();
    wallet.respond = () => 'silent';
    vi.useFakeTimers();
    const pending = rejection(client.payInvoice('lnbc1'));
    await vi.advanceTimersByTimeAsync(10);
    const request = wallet.calls('pay_invoice')[0].event;
    // Network JSON does not carry nostr-tools' cached verification symbol.
    relay.emit(JSON.parse(JSON.stringify({ ...request, kind: NWC_KINDS.response, pubkey: wallet.walletPubkey, tags: [['p', wallet.clientPubkey], ['e', request.id]], sig: '0'.repeat(128) })));
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).code).toBe('wallet-timeout');
  });
});
