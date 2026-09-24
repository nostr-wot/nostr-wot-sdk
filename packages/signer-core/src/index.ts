/**
 * `@nostr-wot/signer-core` — the pipeline every `@nostr-wot` signer runs requests through.
 *
 * One request contract for every transport, the permission gate in front of everything, the
 * approval queue with its caps and timeout, the vault as the only source of key material, and
 * an activity entry for every request that got past the boundary. A host supplies the ports;
 * nothing here touches a platform global.
 */
export type {
  SignerMethod,
  RequestOrigin,
  SignerRequest,
  EventTemplateInput,
  ValidatedParams,
  ValidatedRequest,
  ApprovalDecision,
  ApprovalPort,
  ActivityEntry,
  ActivityPort,
  IdentityPort,
  UnlockPort,
  RemoteSignerPort,
  RelayListPort,
  SignerLogger,
  PendingKind,
  PendingEntry,
  SignerCoreDeps,
} from './types.js';

export {
  MAX_PENDING_PER_ORIGIN,
  REQUEST_TIMEOUT_MS,
  GET_PUBLIC_KEY_COOLDOWN_MS,
  MAX_IN_FLIGHT_PER_ORIGIN,
  MAX_IN_FLIGHT_GLOBAL,
  MAX_EVENT_BYTES,
  MAX_EVENT_TAGS,
  MAX_TAG_VALUES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  SIGNER_METHODS,
  ORIGIN_KINDS,
  KEY_METHODS,
} from './constants.js';

export { SignerError, type SignerErrorCode } from './errors.js';
export { validateRequest, utf8ByteLength } from './schema.js';
export { ApprovalQueue, type ApprovalQueueOptions, type TrackInput } from './queue.js';
