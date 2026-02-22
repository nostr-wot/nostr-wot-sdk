// Context and Provider
export {
  WoTProvider,
  useWoTContext,
  useWoTInstance,
  useExtension,
  type WoTProviderProps,
  type WoTContextValue,
  type ExtensionState,
  type ExtensionConnectionState,
} from './context';

// Primitives (SolidJS reactive primitives)
export {
  createWoT,
  createIsInWoT,
  createTrustScore,
  createBatchWoT,
  type WoTResult,
  type WoTQueryOptions,
  type IsInWoTResult,
  type TrustScoreResult,
  type BatchWoTResult,
} from './primitives';

// Re-export common types
export type {
  WoTOptions,
  QueryOptions,
  DistanceResult,
  DistanceBatchOptions,
} from '../types';

// Re-export WoT class for convenience
export { WoT } from '../wot';
