import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react';
import { WoT } from '../wot';
import type { WoTOptions, NostrWindow } from '../types';

/**
 * Extension connection state
 */
export type ExtensionConnectionState =
  | 'checking'
  | 'connected'
  | 'not-available';

/**
 * Extension status exposed to consumers
 */
export interface ExtensionState {
  /**
   * Current connection state
   */
  state: ExtensionConnectionState;
  /**
   * Whether extension is connected and ready
   */
  isConnected: boolean;
  /**
   * Whether extension is currently checking
   */
  isChecking: boolean;
  /**
   * Whether check is complete
   */
  isChecked: boolean;
  /**
   * Manually trigger a check
   */
  refresh: () => void;
}

/**
 * WoT context value
 */
interface WoTContextValue {
  wot: WoT | null;
  isReady: boolean;
  extension: ExtensionState;
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
 * Check if extension is available
 */
function checkExtensionAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as NostrWindow).nostr?.wot;
}

/**
 * WoT provider component
 *
 * Provides WoT instance to all children components.
 * Automatically detects extension availability.
 *
 * @example
 * ```tsx
 * import { WoTProvider } from 'nostr-wot-sdk/react';
 *
 * // Basic usage - automatically detects extension
 * function App() {
 *   return (
 *     <WoTProvider>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 *
 * // With fallback for when extension is not available
 * function App() {
 *   return (
 *     <WoTProvider options={{
 *       fallback: { myPubkey: 'abc123...' }
 *     }}>
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
  const [extensionState, setExtensionState] = useState<ExtensionConnectionState>('checking');
  const [isReady, setIsReady] = useState(false);

  // Check extension availability
  const checkExtension = useCallback(() => {
    const available = checkExtensionAvailable();
    setExtensionState(available ? 'connected' : 'not-available');
    setIsReady(true);
  }, []);

  // Check on mount
  useEffect(() => {
    checkExtension();
  }, [checkExtension]);

  // Create WoT instance
  const wot = useMemo(() => {
    if (!isReady) {
      return null;
    }

    try {
      return new WoT(options);
    } catch (error) {
      console.error('WoTProvider: Failed to create WoT instance:', error);
      return null;
    }
  }, [
    isReady,
    options.oracle,
    options.myPubkey,
    options.maxHops,
    options.timeout,
    options.fallback?.myPubkey,
    options.fallback?.oracle,
  ]);

  // Extension state for consumers
  const extension = useMemo<ExtensionState>(() => {
    const isConnected = extensionState === 'connected';
    const isChecking = extensionState === 'checking';
    const isChecked = extensionState !== 'checking';

    return {
      state: extensionState,
      isConnected,
      isChecking,
      isChecked,
      refresh: checkExtension,
    };
  }, [extensionState, checkExtension]);

  const value = useMemo<WoTContextValue>(
    () => ({
      wot,
      isReady: isReady && wot !== null,
      extension,
    }),
    [wot, isReady, extension]
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

/**
 * Hook to access extension state
 *
 * @returns Extension state and status
 *
 * @example
 * ```tsx
 * function ExtensionStatus() {
 *   const { isConnected, isChecking } = useExtension();
 *
 *   if (isChecking) return <span>Checking...</span>;
 *   if (isConnected) return <span>Extension connected!</span>;
 *   return <span>Extension not available</span>;
 * }
 * ```
 */
export function useExtension(): ExtensionState {
  const { extension } = useWoTContext();
  return extension;
}
