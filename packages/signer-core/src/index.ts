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
  SignerBatchItem,
  SignerBatchRequest,
  ValidatedBatchItem,
  ValidatedBatch,
  BatchItemOutcome,
  BatchResult,
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
  MAX_REQUEST_ID_LENGTH,
  MAX_ORIGIN_IDENTIFIER_LENGTH,
  MAX_ORIGIN_DISPLAY_NAME_LENGTH,
  MAX_ORIGIN_ICON_LENGTH,
  MAX_EVENT_BYTES,
  MAX_EVENT_TAGS,
  MAX_TAG_VALUES,
  MAX_CRYPTO_PLAINTEXT_BYTES,
  MAX_CRYPTO_CIPHERTEXT_LENGTH,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
  RECIPIENT_KEM_KEY_LENGTH,
  SIGNER_METHODS,
  ORIGIN_KINDS,
  KEY_METHODS,
} from './constants.js';

export { SignerError, type SignerErrorCode } from './errors.js';
export { validateRequest, validateBatchRequest, utf8ByteLength } from './schema.js';
export { ApprovalQueue, type ApprovalQueueOptions, type TrackInput } from './queue.js';
export { SignerCore, permissionOrigin } from './core.js';
export { withPqKeys, PQ_SEED_WORD_COUNT, type PqKeyScope } from './pq.js';
/**
 * The attestation kind, and the check for someone else's attestation: kind, secp256k1
 * signature, then the tags. Re-exported from `@nostr-wot/pq` so a host that only publishes
 * and verifies attestations through this pipeline needs no second dependency.
 */
export { PQC_KIND, verifyAttestation as verifyPqAttestation, type PqAttestation, type PqProblem } from '@nostr-wot/pq';
