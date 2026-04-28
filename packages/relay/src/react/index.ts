// Context and Provider
export {
  RelayProvider,
  useRelayContext,
  useRelayPool,
  useQueryBatcher,
  useRelayStats,
  useRelayStatuses,
  type RelayProviderProps,
  type RelayContextValue,
} from './context';

// Re-export core relay classes for convenience
export { QueryBatcher } from '../QueryBatcher';
export { RelayPool } from '../RelayPool';
export { RelayStats } from '../RelayStats';
export { RelayManager, type RelayManagerOptions } from '../RelayManager';

// Re-export common types
export type {
  PoolLike,
  SubCloser,
  NostrEvent,
  NostrFilter,
  QueryBatcherOptions,
  QueryOptions,
  RelayPoolOptions,
  RelayStatus,
  RelayStatsOptions,
  RelayMetrics,
  RelayStatsData,
  RelayStatsPersistence,
} from '../types';
