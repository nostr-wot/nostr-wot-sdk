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
  useBatchWoT,
  type UseWoTResult,
  type UseWoTOptions,
  type UseIsInWoTResult,
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
