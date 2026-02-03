// Context and Provider
export {
  WoTProvider,
  useWoTContext,
  useWoTInstance,
  type WoTProviderProps,
} from './context';

// Hooks
export {
  useWoT,
  useIsInWoT,
  useTrustScore,
  useBatchWoT,
  type UseWoTResult,
  type UseWoTOptions,
  type UseIsInWoTResult,
  type UseTrustScoreResult,
  type UseBatchWoTResult,
} from './hooks';

// Re-export common types
export type {
  WoTOptions,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
} from '../types';

// Re-export WoT class for convenience
export { WoT } from '../wot';
