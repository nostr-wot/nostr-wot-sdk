/** @jsxImportSource solid-js */
import {
  createContext,
  useContext,
  createSignal,
  createMemo,
  onMount,
  onCleanup,
  type JSX,
  type Accessor,
} from 'solid-js';
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
  state: Accessor<ExtensionConnectionState>;
  /**
   * Whether extension is connected and ready
   */
  isConnected: Accessor<boolean>;
  /**
   * Whether extension is currently checking
   */
  isChecking: Accessor<boolean>;
  /**
   * Whether check is complete
   */
  isChecked: Accessor<boolean>;
  /**
   * Manually trigger a check
   */
  refresh: () => void;
}

/**
 * WoT context value
 */
export interface WoTContextValue {
  wot: Accessor<WoT | null>;
  isReady: Accessor<boolean>;
  extension: ExtensionState;
}

/**
 * WoT context
 */
const WoTContext = createContext<WoTContextValue>();

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
  children: JSX.Element;
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
 * import { WoTProvider } from 'nostr-wot-sdk/solid';
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
export function WoTProvider(props: WoTProviderProps) {
  const [extensionState, setExtensionState] = createSignal<ExtensionConnectionState>('checking');
  const [isReady, setIsReady] = createSignal(false);

  // Check extension availability (manual refresh)
  const checkExtension = () => {
    const available = checkExtensionAvailable();
    setExtensionState(available ? 'connected' : 'not-available');
    setIsReady(true);
  };

  // Check on mount with retry mechanism
  // Extensions inject their content scripts asynchronously after page load,
  // so we need to poll for a short period to detect them reliably
  onMount(() => {
    // Check immediately
    if (checkExtensionAvailable()) {
      setExtensionState('connected');
      setIsReady(true);
      return;
    }

    // Retry several times - extensions may inject after page load
    let attempts = 0;
    const maxAttempts = 15;
    const intervalMs = 100; // Check every 100ms for 1.5 seconds total

    const intervalId = setInterval(() => {
      attempts++;

      if (checkExtensionAvailable()) {
        setExtensionState('connected');
        setIsReady(true);
        clearInterval(intervalId);
        return;
      }

      if (attempts >= maxAttempts) {
        setExtensionState('not-available');
        setIsReady(true);
        clearInterval(intervalId);
      }
    }, intervalMs);

    onCleanup(() => clearInterval(intervalId));
  });

  // Create WoT instance
  const wot = createMemo(() => {
    if (!isReady()) {
      return null;
    }

    try {
      return new WoT(props.options);
    } catch (error) {
      console.error('WoTProvider: Failed to create WoT instance:', error);
      return null;
    }
  });

  // Extension state for consumers
  const extension: ExtensionState = {
    state: extensionState,
    isConnected: createMemo(() => extensionState() === 'connected'),
    isChecking: createMemo(() => extensionState() === 'checking'),
    isChecked: createMemo(() => extensionState() !== 'checking'),
    refresh: checkExtension,
  };

  const value: WoTContextValue = {
    wot,
    isReady: createMemo(() => isReady() && wot() !== null),
    extension,
  };

  return (
    <WoTContext.Provider value={value}>
      {props.children}
    </WoTContext.Provider>
  );
}

/**
 * Hook to access WoT context
 *
 * @returns WoT context value
 * @throws If used outside of WoTProvider
 */
export function useWoTContext(): WoTContextValue {
  const context = useContext(WoTContext);

  if (context === undefined) {
    throw new Error('useWoTContext must be used within a WoTProvider');
  }

  return context;
}

/**
 * Hook to access WoT instance directly
 *
 * @returns Accessor for WoT instance or null if not ready
 */
export function useWoTInstance(): Accessor<WoT | null> {
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
 *   const ext = useExtension();
 *
 *   return (
 *     <Show when={!ext.isChecking()} fallback={<span>Checking...</span>}>
 *       <Show when={ext.isConnected()} fallback={<span>Extension not available</span>}>
 *         <span>Extension connected!</span>
 *       </Show>
 *     </Show>
 *   );
 * }
 * ```
 */
export function useExtension(): ExtensionState {
  const { extension } = useWoTContext();
  return extension;
}
