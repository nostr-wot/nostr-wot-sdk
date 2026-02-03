// LocalWoT class
export { LocalWoT } from './local-wot';

// Storage adapters
export { MemoryStorage, IndexedDBStorage, createStorage } from './storage';

// Relay utilities
export { RelayConnection, RelayPool, extractFollows } from './relay';

// Re-export common types
export type {
  LocalWoTOptions,
  SyncOptions,
  SyncProgress,
  StorageAdapter,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
  BatchResult,
} from '../types';

// Re-export errors
export {
  WoTError,
  ValidationError,
  StorageError,
  RelayError,
} from '../errors';
