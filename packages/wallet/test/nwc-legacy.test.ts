import { describe, expect, it } from 'vitest';
import type { SimplePool, Event, Filter } from 'nostr-tools';
import { NwcClient, parseNwcUri } from '../src/nwc';
import { codeForWalletError } from '../src/nwc/errors';
import { FakeRelayFactory } from '@nostr-wot/relay/hub';
import { FakeNwcWallet } from './support/fake-nwc-wallet';

describe('root NWC API compatibility', () => {
  it('keeps the connection and payment shapes while using negotiated encryption', async () => {
    const wallet = new FakeNwcWallet();
    const relay = wallet.attach(new FakeRelayFactory())(wallet.relayUrl, { id: 'legacy-wallet', pubkey: null, signer: null, authPolicy: 'never-auth' });
    await relay.connect();
    const pool = {
      subscribeMany: (_relays: string[], filter: Filter, handlers: { onevent(event: Event): void; oneose(): void }) => relay.subscribe([filter], handlers),
      publish: (_relays: string[], event: Event) => [relay.publish(event)],
      querySync: (_relays: string[], filter: Filter) => new Promise<Event[]>((resolve) => {
        const events: Event[] = [];
        const sub = relay.subscribe([filter], { onevent: (event) => events.push(event), oneose: () => { sub.close(); resolve(events); } });
      }),
    } as unknown as SimplePool;
    const parsed = parseNwcUri(wallet.uri);
    expect(parsed.relay).toBe(wallet.relayUrl);
    expect(parsed.clientSecretKey).toEqual(wallet.clientSecret);
    const client = new NwcClient(parsed, pool);
    expect(await client.payInvoice('lnbc1')).toEqual({ preimage: 'ab'.repeat(32), fees_paid: 0 });
    expect(wallet.calls('pay_invoice')[0].encryption).toBe('nip44_v2');
    expect(await client.getInfo()).toMatchObject({ alias: 'Test Wallet' });
  });

  it.each(['toString', '__proto__', 'constructor'])('treats inherited property %s as an unknown wallet code', (code) => {
    expect(codeForWalletError(code)).toBe('wallet-failed');
  });
});
