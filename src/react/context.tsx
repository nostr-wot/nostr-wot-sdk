import {
  createContext,
  useContext,
  useState,
  useEffect,
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
const WoTContext = createContext<WoTContextValue>({
  wot: null,
  isReady: false,
});

/**
 * WoT provider props
 */
export interface WoTProviderProps {
  /**
   * WoT configuration options
   */
  options: WoTOptions;
  /**
   * Children to render
   */
  children: ReactNode;
}

/**
 * WoT provider component
 *
 * Provides WoT instance to all children components
 *
 * @example
 * ```tsx
 * import { WoTProvider } from 'nostr-wot-sdk/react';
 *
 * function App() {
 *   return (
 *     <WoTProvider options={{ oracle: 'https://nostr-wot.com', myPubkey: 'abc...' }}>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 * ```
 */
export function WoTProvider({ options, children }: WoTProviderProps) {
  const [isReady, setIsReady] = useState(false);

  // Create WoT instance
  const wot = useMemo(() => {
    try {
      return new WoT(options);
    } catch {
      return null;
    }
  }, [options.oracle, options.myPubkey, options.maxHops, options.timeout]);

  useEffect(() => {
    setIsReady(wot !== null);
  }, [wot]);

  const value = useMemo(
    () => ({
      wot,
      isReady,
    }),
    [wot, isReady]
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

  if (context.wot === null && !context.isReady) {
    // Check if we're in a provider
    const inProvider = useContext(WoTContext) !== undefined;
    if (!inProvider) {
      throw new Error('useWoTContext must be used within a WoTProvider');
    }
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
