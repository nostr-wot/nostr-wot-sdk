import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { buildZapRequest, requestZapInvoice } from '../src/zap-request';
import { zapViaWebLN } from '../src/webln';

const secret = generateSecretKey();
const signer = {
  getPublicKey: async () => getPublicKey(secret),
  signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret),
};
const args = {
  recipientPubkey: 'ab'.repeat(32),
  amountMsats: 21000,
  relays: ['wss://relay.example'],
  comment: 'Gracias ⚡ + 100% & café?',
};

afterEach(() => vi.unstubAllGlobals());

describe('LNURL zap callback encoding', () => {
  it('preserves the encoded builder output for callers that construct URLs themselves', async () => {
    const { event, encoded } = await buildZapRequest(signer, args);
    expect(decodeURIComponent(encoded)).toBe(JSON.stringify(event));
  });

  it.each(['invoice', 'webln'] as const)('sends JSON encoded exactly once through the %s API', async (api) => {
    const pay = vi.fn(async () => ({ preimage: 'test-preimage' }));
    vi.stubGlobal('window', { webln: { enable: vi.fn(async () => {}), sendPayment: pay } });
    let callbackCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/.well-known/lnurlp/alice') {
        return Response.json({
          callback: 'https://pay.example/callback?token=keep%2Bme',
          allowsNostr: true, minSendable: 1000, maxSendable: 1000000,
        });
      }
      callbackCount++;
      expect(url.searchParams.get('token')).toBe('keep+me');
      expect(url.searchParams.get('amount')).toBe('21000');
      expect(url.searchParams.get('comment')).toBe(args.comment);
      // HTTP query parsing already decodes percent escapes. A provider must
      // be able to parse this directly, without an extra decodeURIComponent.
      const event = JSON.parse(url.searchParams.get('nostr')!);
      expect(verifyEvent(event)).toBe(true);
      expect(event.content).toBe(args.comment);
      expect(event.tags).toContainEqual(['p', args.recipientPubkey]);
      expect(event.tags).toContainEqual(['amount', '21000']);
      return Response.json({ pr: 'lnbc-test-invoice' });
    });
    if (api === 'invoice') {
      const result = await requestZapInvoice(signer, { ...args, lud16: 'alice@example.com', fetchImpl });
      expect(result.invoice).toBe('lnbc-test-invoice');
      expect(pay).not.toHaveBeenCalled();
    } else {
      await zapViaWebLN({ signer, recipientPubkey: args.recipientPubkey, recipientLud16: 'alice@example.com', amountSats: 21, relays: args.relays, comment: args.comment, fetchImpl });
      expect(pay).toHaveBeenCalledExactlyOnceWith('lnbc-test-invoice');
    }
    expect(callbackCount).toBe(1);
  });
});
