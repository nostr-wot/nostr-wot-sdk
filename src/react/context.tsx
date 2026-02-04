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
import type { WoTOptions } from '../types';
import {
  ExtensionConnector,
  type ExtensionConnectionState,
  type ExtensionConnectionOptions,
} from '../extension';

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
   * Whether extension is currently connecting
   */
  isConnecting: boolean;
  /**
   * Whether extension check is complete (installed or not)
   */
  isChecked: boolean;
  /**
   * Whether extension is installed (may still be connecting)
   */
  isInstalled: boolean;
  /**
   * Error message if connection failed
   */
  error?: string;
  /**
   * Manually trigger a connection attempt
   */
  connect: () => Promise<void>;
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
   * When useExtension is true (default), the provider will automatically
   * detect and connect to the browser extension.
   */
  options?: Partial<WoTOptions>;
  /**
   * Extension connection options
   */
  extensionOptions?: ExtensionConnectionOptions;
  /**
   * Children to render
   */
  children: ReactNode;
}

/**
 * WoT provider component
 *
 * Provides WoT instance to all children components.
 * Automatically handles extension detection and connection.
 *
 * @example
 * ```tsx
 * import { WoTProvider } from 'nostr-wot-sdk/react';
 *
 * // Extension mode (recommended) - automatically connects to extension
 * function App() {
 *   return (
 *     <WoTProvider>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 *
 * // With fallback for when extension is not installed
 * function App() {
 *   return (
 *     <WoTProvider options={{
 *       fallback: { myPubkey: 'abc123...' }
 *     }}>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 *
 * // Oracle mode (no extension)
 * function App() {
 *   return (
 *     <WoTProvider options={{
 *       useExtension: false,
 *       myPubkey: 'abc123...'
 *     }}>
 *       <YourApp />
 *     </WoTProvider>
 *   );
 * }
 * ```
 */
export function WoTProvider({
  options = {},
  extensionOptions = {},
  children,
}: WoTProviderProps) {
  // Default to extension mode
  const useExtension = options.useExtension ?? true;

  const [extensionState, setExtensionState] = useState<ExtensionConnectionState>('idle');
  const [extensionError, setExtensionError] = useState<string | undefined>();
  const [isReady, setIsReady] = useState(false);

  // Create connector instance
  const connector = useMemo(
    () => new ExtensionConnector(extensionOptions),
    [extensionOptions.checkTimeout, extensionOptions.connectTimeout]
  );

  // Connect function for manual reconnection
  const connect = useCallback(async () => {
    if (!useExtension) return;

    const result = await connector.connect();
    setExtensionState(result.state);
    setExtensionError(result.error);
  }, [connector, useExtension]);

  // Auto-connect on mount when using extension
  useEffect(() => {
    if (!useExtension) {
      setExtensionState('idle');
      setIsReady(true);
      return;
    }

    // Subscribe to state changes
    const unsubscribe = connector.subscribe((result) => {
      setExtensionState(result.state);
      setExtensionError(result.error);
    });

    // Start connection
    connector.connect().then(() => {
      setIsReady(true);
    });

    return () => {
      unsubscribe();
    };
  }, [connector, useExtension]);

  // Create WoT instance
  const wot = useMemo(() => {
    // In extension mode, wait for connection check to complete
    if (useExtension && !isReady) {
      return null;
    }

    // Build options based on extension state
    const wotOptions: WoTOptions = {
      ...options,
      useExtension,
    };

    // If not using extension, myPubkey is required
    if (!useExtension && !options.myPubkey) {
      console.warn('WoTProvider: myPubkey is required when useExtension is false');
      return null;
    }

    try {
      return new WoT(wotOptions);
    } catch (error) {
      console.error('WoTProvider: Failed to create WoT instance:', error);
      return null;
    }
  }, [
    useExtension,
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
    const isConnecting = extensionState === 'checking' || extensionState === 'connecting';
    const isChecked = extensionState !== 'idle' && extensionState !== 'checking';
    const isInstalled = extensionState !== 'not-installed' && extensionState !== 'idle';

    return {
      state: extensionState,
      isConnected,
      isConnecting,
      isChecked,
      isInstalled,
      error: extensionError,
      connect,
    };
  }, [extensionState, extensionError, connect]);

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
 *   const { isConnected, isConnecting, isInstalled, error } = useExtension();
 *
 *   if (isConnecting) return <span>Connecting...</span>;
 *   if (!isInstalled) return <span>Extension not installed</span>;
 *   if (error) return <span>Error: {error}</span>;
 *   if (isConnected) return <span>Connected!</span>;
 *
 *   return null;
 * }
 * ```
 */
export function useExtension(): ExtensionState {
  const { extension } = useWoTContext();
  return extension;
}
