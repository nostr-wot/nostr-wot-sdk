import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8Encoder } from "nostr-tools/utils";
import type { BunkerState, UnsignedBunkerState } from "./types";

const STATE_VERSION = 2;
const MAC_DOMAIN = "nostr-wot/bunker/state/v2";

/**
 * The bytes the MAC covers: a fixed-key-order serialization of every field
 * `restore` reads, in the order the arrays hold them. Fields outside this
 * set are neither authenticated nor used.
 */
export function canonicalState(state: UnsignedBunkerState): Uint8Array {
  const secrets = (Array.isArray(state.secrets) ? state.secrets : []).map((r) => ({
    secret: r?.secret,
    origin: r?.origin,
    relays: r?.relays,
    ...(r?.clientPubkey !== undefined ? { clientPubkey: r.clientPubkey } : {}),
    confirmed: r?.confirmed,
    ...(r?.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
  }));
  const clients = (Array.isArray(state.clients) ? state.clients : []).map((c) => ({
    clientPubkey: c?.clientPubkey,
    relays: c?.relays,
    ...(c?.secret !== undefined ? { secret: c.secret } : {}),
    connectedAt: c?.connectedAt,
  }));
  return utf8Encoder.encode(
    JSON.stringify({ version: state.version, connectionPubkey: state.connectionPubkey, secrets, clients }),
  );
}

function macKey(connectionSecretKey: Uint8Array): Uint8Array {
  return hmac(sha256, connectionSecretKey, utf8Encoder.encode(MAC_DOMAIN));
}

export function stateMac(connectionSecretKey: Uint8Array, state: UnsignedBunkerState): string {
  return bytesToHex(hmac(sha256, macKey(connectionSecretKey), canonicalState(state)));
}

/**
 * Authenticate a state under the connection key. `BunkerServer.exportState`
 * does this for you; it is exported for migration tooling that assembles a
 * state by hand and holds the key.
 */
export function signBunkerState(connectionSecretKey: Uint8Array, state: UnsignedBunkerState): BunkerState {
  const unsigned: UnsignedBunkerState = { ...state, version: STATE_VERSION };
  return { ...unsigned, mac: stateMac(connectionSecretKey, unsigned) };
}

/** True when `state.mac` is the MAC of `state` under this key. Constant-time compare. */
export function verifyBunkerState(connectionSecretKey: Uint8Array, state: BunkerState): boolean {
  if (typeof state.mac !== "string" || state.mac.length !== 64) return false;
  const expected = stateMac(connectionSecretKey, state);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ state.mac.charCodeAt(i);
  return diff === 0;
}

export { STATE_VERSION };
