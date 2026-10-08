import { SimplePool } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { NwcClient as TransportNwcClient, parseNwcUri as parseConnection, NwcError, NWC_KINDS } from './nwc/index';
import { createPoolNwcTransport } from './nwc/pool-transport';

export const NWC_REQUEST_KIND = NWC_KINDS.request;
export const NWC_RESPONSE_KIND = NWC_KINDS.response;

/** Legacy root-entry connection shape; the transport API also exposes all relays and client identity. */
export interface NWCConnection {
  walletPubkey: string;
  relay: string;
  clientSecretKey: Uint8Array;
}

export function parseNwcUri(uri: string): NWCConnection {
  const connection = parseConnection(uri);
  return { walletPubkey: connection.walletPubkey, relay: connection.relays[0], clientSecretKey: connection.secret };
}

export type NwcResult<T = unknown> = { result: T; result_type: string } | { error: { code: string; message: string } };

/**
 * Compatibility facade over the shared NIP-47 protocol client. Existing
 * callers can keep supplying a SimplePool; applications that own their
 * transport use @nostr-wot/wallet/nwc directly.
 */
export class NwcClient {
  readonly #client: TransportNwcClient;

  constructor(connection: NWCConnection, pool?: SimplePool) {
    const validated = parseConnection(`nostr+walletconnect://${connection.walletPubkey}?relay=${encodeURIComponent(connection.relay)}&secret=${bytesToHex(connection.clientSecretKey)}`);
    this.#client = new TransportNwcClient(validated, createPoolNwcTransport(pool ?? new SimplePool(), validated.relays));
  }

  static fromUri(uri: string, pool?: SimplePool): NwcClient {
    return new NwcClient(parseNwcUri(uri), pool);
  }

  async payInvoice(invoice: string): Promise<{ preimage: string; fees_paid?: number }> {
    const result = await this.#client.payInvoice(invoice);
    if (!result.preimage) throw new NwcError('wallet-failed', 'unknown');
    return { preimage: result.preimage, ...(result.feesPaidMsats === null ? {} : { fees_paid: result.feesPaidMsats }) };
  }

  makeInvoice(amountSats: number, description?: string): Promise<{ invoice: string; payment_hash: string }> {
    return this.call('make_invoice', { amount: amountSats * 1000, description: description ?? '' });
  }

  getBalance(): Promise<{ balance: number }> {
    return this.call('get_balance', {});
  }

  getInfo(): Promise<{ alias: string; color: string; pubkey: string; network: string; block_height: number; methods: string[] }> {
    return this.call('get_info', {});
  }

  lookupInvoice(payment_hash: string): Promise<{ invoice?: string; settled?: boolean; settled_at?: number; amount?: number }> {
    return this.call('lookup_invoice', { payment_hash });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return await this.#client.call(method, params, 30_000) as T;
  }
}
