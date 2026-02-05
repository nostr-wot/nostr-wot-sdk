// Context and Provider
export {
  WoTProvider,
  useWoTContext,
  useWoTInstance,
  useExtension,
  type WoTProviderProps,
  type ExtensionState,
  type ExtensionConnectionState,
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
  QueryOptions,
  DistanceResult,
  DistanceBatchOptions,
} from '../types';

// Re-export WoT class for convenience
export { WoT } from '../wot';
