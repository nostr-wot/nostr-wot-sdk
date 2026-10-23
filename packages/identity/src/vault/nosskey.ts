/** Compatibility with nosskey-sdk's NostrKeyInfo, salt.ts and exportNostrKey.
 * Mode comes from an explicitly supplied backup, never from an unknown handle.
 * Uses the existing NIP-44 implementation; no new cryptographic format.
 */
import { nip44 } from 'nostr-tools';
import {
  isValidPrivateKey,
  isValidPublicKey,
  publicKeyFromPrivate,
} from '../accounts/derivation.js';
import { hexToBytes } from './serialization.js';

const DIRECT = '6e6f7374722d70776b';
const WRAP = '6e6f7374722d70776b2d77726170';
const LEGACY = '6e6f7374722d6b6579';
export interface NosskeyAccount {
  credentialId: string;
  pubkey: string;
  salt: string;
  username?: string;
  wrapped?: { v: 1; alg: 'nip44-v2'; payload: string };
}
const invalid = () => new Error('Invalid Nosskey account backup');
function validate(value: unknown): NosskeyAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const a = value as NosskeyAccount;
  if (
    typeof a.credentialId !== 'string' ||
    !/^(?:[a-f0-9]{2}){1,1024}$/.test(a.credentialId) ||
    typeof a.pubkey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(a.pubkey) ||
    !isValidPublicKey(hexToBytes(a.pubkey)) ||
    (a.username !== undefined &&
      (typeof a.username !== 'string' || a.username.length > 256))
  )
    throw invalid();
  const salt = a.salt === undefined || a.salt === LEGACY ? DIRECT : a.salt;
  const hasWrap = Object.prototype.hasOwnProperty.call(a, 'wrapped');
  if (hasWrap) {
    const w = a.wrapped;
    if (
      salt !== WRAP ||
      !w ||
      w.v !== 1 ||
      w.alg !== 'nip44-v2' ||
      typeof w.payload !== 'string' ||
      w.payload.length < 100 ||
      w.payload.length > 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(w.payload)
    )
      throw invalid();
  } else if (salt !== DIRECT) throw invalid();
  return {
    credentialId: a.credentialId,
    pubkey: a.pubkey,
    salt,
    ...(a.username !== undefined ? { username: a.username } : {}),
    ...(hasWrap
      ? { wrapped: { v: 1, alg: 'nip44-v2', payload: a.wrapped!.payload } }
      : {}),
  };
}
/** Parse a single backupKeyInfo() record. RP comes from trusted host configuration, not the file. */
export function parseNosskeyAccount(json: string): NosskeyAccount {
  if (typeof json !== 'string' || json.length > 8192) throw invalid();
  return validate(JSON.parse(json));
}
export function nosskeyPrfInput(account: NosskeyAccount): Uint8Array {
  return hexToBytes(validate(account).salt);
}
/** Caller owns and clears both PRF and returned key. Wrong keys fail, never fall back to direct mode. */
export function recoverNosskeyAccount(
  account: NosskeyAccount,
  prf: Uint8Array,
): Uint8Array {
  const a = validate(account);
  if (!(prf instanceof Uint8Array) || !isValidPrivateKey(prf))
    throw new Error('Invalid Nosskey PRF output');
  let secret: Uint8Array | undefined;
  try {
    if (a.wrapped) {
      const conversation = nip44.v2.utils.getConversationKey(
        prf,
        publicKeyFromPrivate(prf),
      );
      try {
        const plaintext = nip44.v2.decrypt(a.wrapped.payload, conversation);
        if (!/^[a-f0-9]{64}$/.test(plaintext)) throw invalid();
        secret = hexToBytes(plaintext);
      } finally {
        conversation.fill(0);
      }
    } else secret = prf.slice();
    if (!isValidPrivateKey(secret) || publicKeyFromPrivate(secret) !== a.pubkey)
      throw new Error('Nosskey backup does not match this passkey');
    return secret;
  } catch (error) {
    secret?.fill(0);
    throw error;
  }
}
