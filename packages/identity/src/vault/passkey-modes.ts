/**
 * Passkey-held Nostr keys: derived mode (the passkey is the key) and the user handle that tells the
 * modes apart. Stored mode is in passkey-store.ts, the login ceremony in passkey-identity.ts.
 *
 * Derived: `secret = HKDF-SHA256(PRF(SHA-256(salt_label)), salt = SHA-256(salt_label), info_label)`.
 * Handles: `"NPK" | 0x01 | mode | body`, mode 0x01 derived (parameter set, 16 random bytes) or 0x02
 * stored (32-byte author).
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { isValidPrivateKey, publicKeyFromPrivate } from '../accounts/derivation.js';
import { bytesToHex, hexToBytes } from './serialization.js';

/**
 * A frozen pair of labels named by one byte. `0x01` is the specification's default; `0x02` to `0x7f`
 * are assigned in the registry and come from host configuration.
 */
export interface DerivedParameterSet { readonly id: number; readonly saltLabel: string; readonly infoLabel: string; }
export const DEFAULT_DERIVED_PARAMETER_SET: DerivedParameterSet = Object.freeze({ id: 0x01, saltLabel: 'nostr-passkey:derive:v1', infoLabel: 'nostr-passkey:nsec:v1' });

function requireSet(set: DerivedParameterSet): DerivedParameterSet {
  const valid = !!set && Number.isInteger(set.id) && set.id >= 0x01 && set.id <= 0x7f
    && typeof set.saltLabel === 'string' && set.saltLabel.length > 0 && typeof set.infoLabel === 'string' && set.infoLabel.length > 0
    // 0x01 is fixed by the specification and cannot be redefined.
    && (set.id !== DEFAULT_DERIVED_PARAMETER_SET.id || (set.saltLabel === DEFAULT_DERIVED_PARAMETER_SET.saltLabel && set.infoLabel === DEFAULT_DERIVED_PARAMETER_SET.infoLabel));
  if (!valid) throw new Error('Invalid derived parameter set');
  return set;
}

/** Public PRF input for a parameter set. */
export function derivedPrfInput(set: DerivedParameterSet): Uint8Array {
  return sha256(new TextEncoder().encode(requireSet(set).saltLabel));
}

/**
 * Derive the key of a derived-mode passkey. A zero or out-of-range scalar fails with no retry. The
 * caller's PRF buffer is left alone; the caller owns the returned secret and MUST zero it.
 */
export function deriveNostrKey(prfOutput: Uint8Array, set: DerivedParameterSet): { secret: Uint8Array; pubkey: string } {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const salt = derivedPrfInput(set);
  const secret = hkdf(sha256, prfOutput, salt, new TextEncoder().encode(set.infoLabel), 32);
  if (!isValidPrivateKey(secret)) { secret.fill(0); throw new Error('Derived passkey key is not a valid secp256k1 scalar'); }
  return { secret, pubkey: publicKeyFromPrivate(secret) };
}

const TAG = [0x4e, 0x50, 0x4b, 0x01] as const;
const MODE_DERIVED = 0x01;
const MODE_STORED = 0x02;
const DERIVED_HANDLE_BYTES = 22;
const STORED_HANDLE_BYTES = 37;

/** `user.id` for a new derived passkey. The random bytes keep handles unlinkable. */
export function encodeDerivedHandle(set: DerivedParameterSet, random16: Uint8Array = randomBytes(16)): Uint8Array {
  if (!(random16 instanceof Uint8Array) || random16.length !== 16) throw new Error('Derived handle needs 16 random bytes');
  const handle = new Uint8Array(DERIVED_HANDLE_BYTES);
  handle.set(TAG); handle[4] = MODE_DERIVED; handle[5] = requireSet(set).id; handle.set(random16, 6);
  return handle;
}
/** `user.id` for a new stored passkey: it names the author, so a fresh device finds the record unaided. */
export function encodeStoredHandle(author: string): Uint8Array {
  if (typeof author !== 'string' || !/^[a-f0-9]{64}$/.test(author)) throw new Error('Stored handle needs a 32-byte public key');
  const handle = new Uint8Array(STORED_HANDLE_BYTES);
  handle.set(TAG); handle[4] = MODE_STORED; handle.set(hexToBytes(author), 5);
  return handle;
}

export type PasskeyHandleClass =
  /** The byte the handle names. Refuse it unless the host implements that set. */
  | { mode: 'derived'; parameterSet: number }
  | { mode: 'stored'; author: string }
  /** 32 bytes: stored only once a legacy record for that author is found, unknown otherwise. */
  | { mode: 'stored'; author: string; legacy: 'raw-pubkey'; confirmRecord: true }
  /** Withdrawn format with key material in the handle. Read-only, no author. */
  | { mode: 'stored'; legacy: 'key-in-handle' }
  /** NPK-prefixed but not a valid version 1 handle. Refuse it. */
  | { mode: 'unsupported' }
  | { mode: 'unknown' };

/** Classify a credential's `user.id` in the specification's order. A missing handle is unknown. */
export function classifyPasskeyHandle(handle: Uint8Array | null | undefined): PasskeyHandleClass {
  if (!(handle instanceof Uint8Array)) return { mode: 'unknown' };
  const tagged = handle.length >= TAG.length && TAG.every((byte, i) => handle[i] === byte);
  if (tagged && handle.length === DERIVED_HANDLE_BYTES && handle[4] === MODE_DERIVED) return { mode: 'derived', parameterSet: handle[5] };
  if (tagged && handle.length === STORED_HANDLE_BYTES && handle[4] === MODE_STORED) return { mode: 'stored', author: bytesToHex(handle.subarray(5)) };
  // Before the NPK rule, so a public key that happens to start with `4e504b` is still read as one.
  if (handle.length === 32) return { mode: 'stored', author: bytesToHex(handle), legacy: 'raw-pubkey', confirmRecord: true };
  if (handle.length === 33 && handle[0] === 0x03) return { mode: 'stored', legacy: 'key-in-handle' };
  if (handle.length >= 3 && TAG.slice(0, 3).every((byte, i) => handle[i] === byte)) return { mode: 'unsupported' };
  return { mode: 'unknown' };
}
