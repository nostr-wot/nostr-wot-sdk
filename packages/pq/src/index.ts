/**
 * @nostr-wot/pq — post-quantum identity keys for Nostr.
 *
 * Implements the identity layer of the proposed post-quantum NIP: deriving ML-KEM-1024
 * and ML-DSA-87 keys from a NIP-06 seed, and building, parsing and verifying the
 * `kind:10203` attestation that advertises them.
 *
 * It also defines the message envelope (see `./envelope.ts`): a hybrid ML-KEM-1024 +
 * NIP-44 construction sealed with XChaCha20-Poly1305, which rides inside NIP-59 gift
 * wrap unchanged, so post-quantum messages traverse today's relay network with no
 * relay or client changes required of anyone who has not opted in.
 *
 * The one thing this package never does: take a secp256k1 private key as derivation
 * input. Deriving post-quantum keys from the Nostr private key is circular — an
 * adversary who recovers that key from the published pubkey repeats the derivation and
 * obtains the post-quantum key too. Keys are derived as *siblings* of the secp256k1 key
 * from the BIP-39 seed, and because BIP-32 and HKDF are one-way, recovering the
 * secp256k1 key reveals nothing about the seed.
 *
 * @see https://csrc.nist.gov/pubs/fips/203/final — FIPS 203 (ML-KEM)
 * @see https://csrc.nist.gov/pubs/fips/204/final — FIPS 204 (ML-DSA)
 * @see https://github.com/nostr-protocol/nips/blob/master/06.md — NIP-06
 */

import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent } from 'nostr-tools';

// ── Constants ───────────────────────────────────────────────────────────────

/** Replaceable event kind carrying post-quantum public keys. */
export const PQC_KIND = 10203;

/** Derivation profile. Bump when the derivation changes. */
export const PQ_PROFILE = 'nip-pqc/v1';

export const ALG_KEM = 'ml-kem-1024';
export const ALG_DSA = 'ml-dsa-87';

/** Public key sizes per FIPS 203 / 204. */
export const KEM_PUBLIC_KEY_BYTES = 1568;
export const DSA_PUBLIC_KEY_BYTES = 2592;

const KEM_SEED_BYTES = 64; // d || z
const DSA_SEED_BYTES = 32; // xi

/** The NIP-06 sequence: `m/44'/1237'/0'/0/{index}`. Only its members have a numeric selector. */
const NIP06_ACCOUNT_PREFIX = "m/44'/1237'/0'/0/";
/** A canonical private BIP-32 path: `m`, then non-negative indexes, hardened ones with `'`. */
const CANONICAL_PATH = /^m(?:\/(?:0|[1-9]\d*)'?)*$/;
const MAX_BIP32_INDEX = 0x7fffffff;

// ── Types ───────────────────────────────────────────────────────────────────

export interface PqKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface PqKeys {
  kem: PqKeyPair;
  dsa: PqKeyPair;
}

/** How the advertised keys came into existence. */
export type PqOrigin = 'derived' | 'independent';

/** A reason an attestation should not be trusted, as a code plus parameters. */
export interface PqProblem {
  code:
    | 'keyLength'
    | 'noAlgTags'
    | 'noKem'
    | 'derivedWeakSeed'
    | 'derivedMissingSeedStrength'
    | 'missingPop'
    | 'popFailed'
    /** `verifyAttestation` only: the event is not a `kind:10203`. */
    | 'wrongKind'
    /** `verifyAttestation` only: the event's secp256k1 signature does not verify. */
    | 'badSignature';
  params?: Record<string, string | number>;
}

export interface PqAttestation {
  pubkey: string;
  kem: Uint8Array | null;
  dsa: Uint8Array | null;
  origin: PqOrigin | null;
  seedStrength: string | null;
  profile: string | null;
  /** null when no `pop` tag is present; true/false once verified. */
  popValid: boolean | null;
  problems: PqProblem[];
  /** True only when a KEM key is present and nothing failed validation. */
  usable: boolean;
}

/** The minimal event shape this package reads. Compatible with nostr-tools' Event. */
export interface PqEventLike {
  pubkey: string;
  kind: number;
  tags: string[][];
}

/** A signed event as a relay serves it: what {@link verifyAttestation} takes. */
export interface PqSignedEventLike extends PqEventLike {
  id: string;
  created_at: number;
  content: string;
  sig: string;
}

// ── Encoding helpers (no Buffer; works in browsers and Node) ────────────────

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line no-undef
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

export function fromBase64(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ── Derivation ──────────────────────────────────────────────────────────────

function deriveSeed(seed: Uint8Array, info: string, length: number): Uint8Array {
  const prk = hkdfExtract(sha256, seed, undefined);
  try {
    return hkdfExpand(sha256, prk, encoder.encode(info), length);
  } finally {
    prk.fill(0);
  }
}

/**
 * Which account a derivation is for: a NIP-06 account index, or the canonical BIP-32 path
 * the account was restored at. See {@link derivationSelector}.
 */
export type PqAccount = number | string;

/**
 * The account's place in the `info` string.
 *
 * A number is the NIP-06 account index and is spelled as itself, the published selector. A
 * string is a BIP-32 path: a member of the NIP-06 sequence (`m/44'/1237'/0'/0/{n}`) keeps
 * the numeric selector `n`, so an account restored at its standard path derives the same
 * keys it did before paths were stored; any other path gets the namespace `path/<path>`
 * and is never collapsed to its last child index, since two custom paths sharing a last
 * index would otherwise share post-quantum keys. This is the extension's rule, spelled
 * the same, so the two derive the same keys for the same account.
 *
 * The path has to be canonical already: `m`, then decimal indexes, hardened ones marked
 * with `'` (not `h` or `H`), no whitespace. The caller that stores paths canonicalises them
 * (`normalizeDerivationPath` in `@nostr-wot/accounts`); anything else is refused rather than
 * derived under a spelling no other implementation would produce.
 */
function derivationSelector(account: PqAccount): string {
  if (typeof account === 'number') {
    if (!Number.isInteger(account) || account < 0) throw new Error('Invalid account index');
    return String(account);
  }
  if (typeof account !== 'string' || !CANONICAL_PATH.test(account)) throw new Error('Invalid derivation path');
  for (const part of account.split('/').slice(1)) {
    if (Number(part.replace("'", '')) > MAX_BIP32_INDEX) throw new Error('Invalid derivation path');
  }
  if (account.startsWith(NIP06_ACCOUNT_PREFIX)) {
    const suffix = account.slice(NIP06_ACCOUNT_PREFIX.length);
    if (/^\d+$/.test(suffix)) return suffix;
  }
  return `path/${account}`;
}

/** `info` string for the ML-KEM seed at a NIP-06 account index or canonical path. */
export function kemInfo(account: PqAccount = 0): string {
  return `${PQ_PROFILE}/${ALG_KEM}/${derivationSelector(account)}`;
}

/** `info` string for the ML-DSA seed at a NIP-06 account index or canonical path. */
export function dsaInfo(account: PqAccount = 0): string {
  return `${PQ_PROFILE}/${ALG_DSA}/${derivationSelector(account)}`;
}

/**
 * Derive both post-quantum key pairs from a BIP-39 seed.
 *
 * @param seed - the 64-byte BIP-39 seed. NOT a secp256k1 private key; passing one
 *               produces different, unrelated keys and defeats the whole design.
 * @param account - NIP-06 account index, or the canonical BIP-32 path the account was
 *                  restored at (see {@link PqAccount})
 */
export function derivePqKeys(seed: Uint8Array, account: PqAccount = 0): PqKeys {
  if (!(seed instanceof Uint8Array) || seed.length === 0) throw new Error('Invalid seed');
  derivationSelector(account); // refuses a bad account before any secret is expanded

  const kemSeed = deriveSeed(seed, kemInfo(account), KEM_SEED_BYTES);
  const dsaSeed = deriveSeed(seed, dsaInfo(account), DSA_SEED_BYTES);
  try {
    return { kem: ml_kem1024.keygen(kemSeed), dsa: ml_dsa87.keygen(dsaSeed) };
  } finally {
    kemSeed.fill(0);
    dsaSeed.fill(0);
  }
}

// ── Proof of possession ─────────────────────────────────────────────────────

/**
 * The message the ML-DSA key signs, binding the npub and both post-quantum keys.
 *
 * ML-KEM cannot sign, so this counter-signature is what gives the encapsulation key
 * a possession proof at all.
 */
export function popMessage(pubkeyHex: string, kemB64: string, dsaB64: string): Uint8Array {
  return encoder.encode(`${PQ_PROFILE}/pop:${pubkeyHex}:${kemB64}:${dsaB64}`);
}

export function signPop(message: Uint8Array, dsaSecretKey: Uint8Array): Uint8Array {
  return ml_dsa87.sign(message, dsaSecretKey);
}

export function verifyPop(
  signature: Uint8Array,
  message: Uint8Array,
  dsaPublicKey: Uint8Array,
): boolean {
  try {
    return ml_dsa87.verify(signature, message, dsaPublicKey);
  } catch {
    return false;
  }
}

// ── KEM operations ──────────────────────────────────────────────────────────

export function encapsulate(kemPublicKey: Uint8Array): {
  cipherText: Uint8Array;
  sharedSecret: Uint8Array;
} {
  if (kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid ML-KEM public key length');
  }
  return ml_kem1024.encapsulate(kemPublicKey);
}

export function decapsulate(cipherText: Uint8Array, kemSecretKey: Uint8Array): Uint8Array {
  return ml_kem1024.decapsulate(cipherText, kemSecretKey);
}

/**
 * Combine the post-quantum shared secret with the classic NIP-44 conversation key.
 *
 * The KEM secret MUST NOT be used alone. Hashing both together means the result is no
 * weaker than either input, so a flaw in a comparatively young lattice scheme cannot
 * make messaging worse than it is today.
 */
export function hybridKey(sharedSecret: Uint8Array, conversationKey: Uint8Array): Uint8Array {
  const ikm = new Uint8Array(sharedSecret.length + conversationKey.length);
  ikm.set(sharedSecret, 0);
  ikm.set(conversationKey, sharedSecret.length);
  const prk = hkdfExtract(sha256, ikm, undefined);
  try {
    return hkdfExpand(sha256, prk, encoder.encode(`${PQ_PROFILE}/hybrid`), 32);
  } finally {
    ikm.fill(0);
    prk.fill(0);
  }
}

// ── Attestation ─────────────────────────────────────────────────────────────

/**
 * Build the tags for a `kind:10203` attestation. The caller signs and publishes it.
 *
 * `origin: 'derived'` asserts that one mnemonic restores these keys, so it is only
 * valid from a 256-bit seed. Anything weaker must be published as `independent`.
 */
export function buildAttestationTags(input: {
  pubkey: string;
  kem: Uint8Array;
  dsa: Uint8Array;
  origin: PqOrigin;
  dsaSecretKey: Uint8Array;
}): string[][] {
  const kemB64 = toBase64(input.kem);
  const dsaB64 = toBase64(input.dsa);
  const pop = signPop(popMessage(input.pubkey, kemB64, dsaB64), input.dsaSecretKey);

  const tags: string[][] = [
    ['alg', ALG_KEM, kemB64],
    ['alg', ALG_DSA, dsaB64],
    ['origin', input.origin],
  ];
  if (input.origin === 'derived') tags.push(['seed_strength', '256']);
  tags.push(['v', PQ_PROFILE], ['pop', ALG_DSA, toBase64(pop)]);
  return tags;
}

function expectedBytesFor(alg: string): number | null {
  if (alg === ALG_KEM) return KEM_PUBLIC_KEY_BYTES;
  if (alg === ALG_DSA) return DSA_PUBLIC_KEY_BYTES;
  return null;
}

/**
 * Parse and validate a `kind:10203` event.
 *
 * Strict by design: a malformed or unproven attestation is reported with `usable:
 * false` and an explicit problem list rather than being partially accepted. The
 * failure this guards against is a sender believing a recipient is reachable
 * post-quantum when they are not — silent downgrade is the worst outcome available.
 *
 * NOTE: this does not verify the event's secp256k1 signature. Callers MUST do that
 * separately (e.g. `verifyEvent` from nostr-tools) before trusting the result.
 */
export function parseAttestation(event: PqEventLike): PqAttestation {
  const problems: PqProblem[] = [];
  const algTags = event.tags.filter((t) => t[0] === 'alg' && t.length >= 3);

  let kem: Uint8Array | null = null;
  let dsa: Uint8Array | null = null;
  let kemB64 = '';
  let dsaB64 = '';

  for (const t of algTags) {
    const alg = t[1]!;
    const b64 = t[2]!;
    const expected = expectedBytesFor(alg);
    if (expected === null) continue; // unknown algorithms are ignored, not an error

    let bytes: Uint8Array;
    try {
      bytes = fromBase64(b64);
    } catch {
      problems.push({ code: 'keyLength', params: { alg, bytes: -1, expected } });
      continue;
    }
    if (bytes.length !== expected) {
      problems.push({ code: 'keyLength', params: { alg, bytes: bytes.length, expected } });
      continue;
    }
    if (alg === ALG_KEM) { kem = bytes; kemB64 = b64; }
    if (alg === ALG_DSA) { dsa = bytes; dsaB64 = b64; }
  }

  if (algTags.length === 0) problems.push({ code: 'noAlgTags' });
  if (!kem) problems.push({ code: 'noKem', params: { alg: ALG_KEM } });

  const first = (name: string): string | null => {
    const t = event.tags.find((x) => x[0] === name);
    return t && t[1] ? t[1] : null;
  };

  const originRaw = first('origin');
  const origin = originRaw === 'derived' || originRaw === 'independent' ? originRaw : null;
  const seedStrength = first('seed_strength');

  if (origin === 'derived') {
    if (!seedStrength) problems.push({ code: 'derivedMissingSeedStrength' });
    else if (seedStrength !== '256') {
      problems.push({ code: 'derivedWeakSeed', params: { bits: seedStrength } });
    }
  }

  const popTag = event.tags.find((t) => t[0] === 'pop' && t.length >= 3);
  let popValid: boolean | null = null;

  if (dsa && !popTag) {
    problems.push({ code: 'missingPop', params: { alg: ALG_DSA } });
  } else if (popTag && dsa && kem) {
    popValid = verifyPop(fromBase64(popTag[2]!), popMessage(event.pubkey, kemB64, dsaB64), dsa);
    if (!popValid) problems.push({ code: 'popFailed' });
  }

  return {
    pubkey: event.pubkey,
    kem,
    dsa,
    origin,
    seedStrength,
    profile: first('v'),
    popValid,
    problems,
    usable: kem !== null && problems.length === 0,
  };
}

/**
 * The whole check for an attestation fetched from a relay: the kind, the event's secp256k1
 * signature, then the tags through {@link parseAttestation}.
 *
 * `parseAttestation` reads tags and trusts the caller to have verified the signature. A
 * caller that forgets is trusting tags anyone could have published under any pubkey, and the
 * result is a sender encrypting to an attacker's KEM key while believing the recipient is
 * reachable post-quantum. So this refuses first: a wrong kind or a bad signature yields
 * `usable: false` with no key at all, before a single tag is read.
 */
export function verifyAttestation(event: PqSignedEventLike): PqAttestation {
  const refused = (code: 'wrongKind' | 'badSignature'): PqAttestation => ({
    pubkey: event.pubkey,
    kem: null,
    dsa: null,
    origin: null,
    seedStrength: null,
    profile: null,
    popValid: null,
    problems: [{ code }],
    usable: false,
  });
  if (event.kind !== PQC_KIND) return refused('wrongKind');
  let valid = false;
  try {
    valid = verifyEvent(event);
  } catch {
    valid = false;
  }
  if (!valid) return refused('badSignature');
  return parseAttestation(event);
}

/** Filter for fetching an identity's attestation from relays. */
export function attestationFilter(pubkeys: string[]) {
  return { kinds: [PQC_KIND], authors: pubkeys };
}

// ── Message envelope ────────────────────────────────────────────────────────

export {
  encryptPq,
  decryptPq,
  isPqEnvelope,
  classifyEnvelope,
  type EnvelopeClass,
  ENVELOPE_VERSION,
  ALG_MLKEM1024_XCHACHA,
  KEM_CIPHERTEXT_BYTES,
  MAX_PLAINTEXT_BYTES,
  ENVELOPE_OVERHEAD_BYTES,
  type EnvelopeParties,
} from './envelope.js';

// ── Direct messages (NIP-17 + NIP-59 composition) ───────────────────────────

export {
  createPqDirectMessage,
  openPqDirectMessage,
  inboxFilter,
  KIND_RUMOR,
  KIND_SEAL,
  KIND_GIFT_WRAP,
  PQ_TAG,
  type CreatePqDmInput,
  type OpenPqDmInput,
  type OpenedPqDm,
} from './dm.js';
