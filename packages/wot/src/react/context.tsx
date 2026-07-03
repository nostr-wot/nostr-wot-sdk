import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { WoT } from '../wot';
import type { WoTOptions } from '../types';

/**
 * WoT context value
 */
interface WoTContextValue {
  wot: WoT | null;
  isReady: boolean;
}

/**
 * WoT context
 */
const WoTContext = createContext<WoTContextValue | null>(null);

/**
 * WoT provider props
 */
export interface WoTProviderProps {
  /**
   * WoT configuration options
   */
  options?: Partial<WoTOptions>;
  /**
   * Children to render
   */
  children: ReactNode;
}

/**
 * WoT provider component
 *
 * Provides a WoT instance to all children components.
 *
 * @example
 * ```tsx
 * import { WoTProvider } from '@nostr-wot/wot/react';
 *
 * function App() {
 *   return (
 *     <WoTProvider options={{ myPubkey: 'abc123...' }}>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 * ```
 */
export function WoTProvider({
  options = {},
  children,
}: WoTProviderProps) {
  // Create WoT instance immediately
  const wot = useMemo(() => {
    try {
      return new WoT(options);
    } catch (error) {
      console.error('WoTProvider: Failed to create WoT instance:', error);
      return null;
    }
  }, [
    options.oracle,
    options.myPubkey,
    options.maxHops,
    options.timeout,
    options.fallback?.myPubkey,
    options.fallback?.oracle,
  ]);

  const value = useMemo<WoTContextValue>(
    () => ({
      wot,
      isReady: wot !== null,
    }),
    [wot]
  );

  return <WoTContext.Provider value={value}>{children}</WoTContext.Provider>;
}

/**
 * Hook to access WoT context
 *
 * @returns WoT context value
 * @throws If used outside of WoTProvider
 */
export function useWoTContext(): WoTContextValue {
  const context = useContext(WoTContext);

  if (context === null) {
    throw new Error('useWoTContext must be used within a WoTProvider');
  }

  return context;
}

/**
 * Hook to access WoT instance directly
 *
 * @returns WoT instance or null if not ready
 */
export function useWoTInstance(): WoT | null {
  const { wot } = useWoTContext();
  return wot;
}
