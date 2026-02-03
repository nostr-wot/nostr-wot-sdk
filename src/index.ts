// Main WoT class
export { WoT } from './wot';

// Types
export type {
  WoTOptions,
  WoTFallbackOptions,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
  ExtensionDistanceResult,
  ExtensionConfig,
  ExtensionStatus,
  GraphStats,
  BatchResult,
  LocalWoTOptions,
  SyncOptions,
  SyncProgress,
  StorageAdapter,
  NostrContactEvent,
  NostrWoTExtension,
  NostrWindow,
} from './types';

// Errors
export {
  WoTError,
  NetworkError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  StorageError,
  RelayError,
} from './errors';

// Utilities (exported for advanced usage)
export {
  calculateTrustScore,
  isValidPubkey,
  isValidOracleUrl,
  isValidRelayUrl,
  normalizePubkey,
  DEFAULT_SCORING,
  DEFAULT_ORACLE,
  DEFAULT_MAX_HOPS,
  DEFAULT_TIMEOUT,
  MAX_BATCH_SIZE,
} from './utils';
