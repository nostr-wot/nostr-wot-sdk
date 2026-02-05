// Main WoT class
export { WoT } from './wot';

// Types
export type {
  WoTOptions,
  WoTFallbackOptions,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
  DistanceBatchOptions,
  ExtensionDistanceResult,
  ExtensionConfig,
  ExtensionStatus,
  GraphStats,
  BatchResult,
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
} from './errors';

// Utilities (exported for advanced usage)
export {
  isValidPubkey,
  isValidOracleUrl,
  normalizePubkey,
  DEFAULT_ORACLE,
  DEFAULT_MAX_HOPS,
  DEFAULT_TIMEOUT,
  MAX_BATCH_SIZE,
} from './utils';
