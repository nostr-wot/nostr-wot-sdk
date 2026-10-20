/**
 * Identity presentation shared by every host.
 *
 * Ported from the extension's `src/domain/accounts/display.ts` and
 * `src/domain/nostr/display.ts`. Only the pubkey-shortening half comes across: the rest of
 * `accountDisplay` depends on the profile domain and on UI concerns, which do not live here.
 */
import { npubEncode } from './bech32.js';

/** `npub1abc...wxyz`, falling back to the hex form when the pubkey will not encode. */
export function shortNpub(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return npub.slice(0, 12) + '...' + npub.slice(-4);
  } catch {
    return pubkey.slice(0, 8) + '...' + pubkey.slice(-4);
  }
}
