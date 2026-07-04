'use client';
// packages/wallet/src/react/useZapReceipts.ts
// React hook that subscribes to NIP-57 kind 9735 zap receipts addressed to
// `pubkey` on the user's default relays and invokes `onReceipt` for each
// receipt that passes validation. Cleans up the subscription on unmount or
// when `pubkey` changes. No replay/cache: callers receive only events that
// arrive after the hook mounts (zap receipts are typically surfaced as
// transient toasts).

import { useEffect } from 'react';
import { getPool, getDefaultRelays } from '@nostr-wot/data';
import { validateZapReceipt, type RawNostrEvent, type ValidatedZapReceipt } from '../zap-receipt';

export function useZapReceipts(
  pubkey: string | null,
  onReceipt: (receipt: ValidatedZapReceipt) => void,
): void {
  useEffect(() => {
    if (!pubkey) return;
    const relays = getDefaultRelays();
    const pool = getPool();
    const sub = pool.subscribeMany(
      relays,
      { kinds: [9735], '#p': [pubkey] },
      {
        onevent(event: unknown) {
          const validated = validateZapReceipt(event as RawNostrEvent, pubkey);
          if (validated) onReceipt(validated);
        },
      },
    );
    return () => sub.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey]);
}
