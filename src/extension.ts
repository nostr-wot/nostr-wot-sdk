/**
 * Extension connection module
 * Handles the event-based communication flow with the nostr-wot browser extension
 */

import type { NostrWoTExtension, NostrWindow } from './types';

/**
 * Extension connection state
 */
export type ExtensionConnectionState =
  | 'idle'
  | 'checking'
  | 'connecting'
  | 'connected'
  | 'not-installed'
  | 'error';

/**
 * Extension connection result
 */
export interface ExtensionConnectionResult {
  state: ExtensionConnectionState;
  extension: NostrWoTExtension | null;
  error?: string;
}

/**
 * Extension connection options
 */
export interface ExtensionConnectionOptions {
  /**
   * Timeout for extension check (ms)
   * @default 100
   */
  checkTimeout?: number;
  /**
   * Timeout for connection (ms)
   * @default 5000
   */
  connectTimeout?: number;
  /**
   * Auto-connect after checking
   * @default true
   */
  autoConnect?: boolean;
}

/**
 * Check if the nostr-wot extension is installed
 * Uses the nostr-wot-check / nostr-wot-present event handshake
 */
export function checkExtension(timeout = 100): Promise<boolean> {
  return new Promise((resolve) => {
    // Not in browser
    if (typeof window === 'undefined') {
      resolve(false);
      return;
    }

    // Already injected?
    const win = window as NostrWindow;
    if (win.nostr?.wot) {
      resolve(true);
      return;
    }

    const handler = () => {
      window.removeEventListener('nostr-wot-present', handler);
      clearTimeout(timer);
      resolve(true);
    };

    window.addEventListener('nostr-wot-present', handler);

    // Timeout if no response
    const timer = setTimeout(() => {
      window.removeEventListener('nostr-wot-present', handler);
      resolve(false);
    }, timeout);

    // Request check
    window.dispatchEvent(new CustomEvent('nostr-wot-check'));
  });
}

/**
 * Connect to the nostr-wot extension
 * Uses the nostr-wot-connect / nostr-wot-ready event handshake
 */
export function connectExtension(timeout = 5000): Promise<NostrWoTExtension> {
  return new Promise((resolve, reject) => {
    // Not in browser
    if (typeof window === 'undefined') {
      reject(new Error('Not in browser environment'));
      return;
    }

    const win = window as NostrWindow;

    // Already available?
    if (win.nostr?.wot) {
      resolve(win.nostr.wot);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const onReady = () => {
      cleanup();
      const ext = (window as NostrWindow).nostr?.wot;
      if (ext) {
        resolve(ext);
      } else {
        reject(new Error('Extension ready event fired but API not found'));
      }
    };

    const onError = (e: Event) => {
      cleanup();
      const detail = (e as CustomEvent).detail;
      reject(new Error(detail?.error || 'Connection failed'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('nostr-wot-ready', onReady);
      window.removeEventListener('nostr-wot-error', onError);
    };

    window.addEventListener('nostr-wot-ready', onReady);
    window.addEventListener('nostr-wot-error', onError);

    // Request connection
    window.dispatchEvent(new CustomEvent('nostr-wot-connect'));

    // Timeout
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Connection timeout'));
    }, timeout);
  });
}

/**
 * Check and connect to the extension in one call
 */
export async function checkAndConnect(
  options: ExtensionConnectionOptions = {}
): Promise<ExtensionConnectionResult> {
  const { checkTimeout = 100, connectTimeout = 5000, autoConnect = true } = options;

  // Not in browser
  if (typeof window === 'undefined') {
    return { state: 'not-installed', extension: null };
  }

  // Check if already available
  const win = window as NostrWindow;
  if (win.nostr?.wot) {
    return { state: 'connected', extension: win.nostr.wot };
  }

  // Check if extension is installed
  const isInstalled = await checkExtension(checkTimeout);

  if (!isInstalled) {
    return { state: 'not-installed', extension: null };
  }

  if (!autoConnect) {
    return { state: 'idle', extension: null };
  }

  // Connect
  try {
    const extension = await connectExtension(connectTimeout);
    return { state: 'connected', extension };
  } catch (error) {
    return {
      state: 'error',
      extension: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Extension connector class for managing connection state
 */
export class ExtensionConnector {
  private state: ExtensionConnectionState = 'idle';
  private extension: NostrWoTExtension | null = null;
  private error: string | undefined;
  private connectionPromise: Promise<ExtensionConnectionResult> | null = null;
  private listeners: Set<(result: ExtensionConnectionResult) => void> = new Set();

  constructor(private options: ExtensionConnectionOptions = {}) {}

  /**
   * Get current state
   */
  getState(): ExtensionConnectionState {
    return this.state;
  }

  /**
   * Get current extension instance
   */
  getExtension(): NostrWoTExtension | null {
    return this.extension;
  }

  /**
   * Get current error
   */
  getError(): string | undefined {
    return this.error;
  }

  /**
   * Get current result
   */
  getResult(): ExtensionConnectionResult {
    return {
      state: this.state,
      extension: this.extension,
      error: this.error,
    };
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (result: ExtensionConnectionResult) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const result = this.getResult();
    for (const listener of this.listeners) {
      listener(result);
    }
  }

  private setState(
    state: ExtensionConnectionState,
    extension: NostrWoTExtension | null = null,
    error?: string
  ) {
    this.state = state;
    this.extension = extension;
    this.error = error;
    this.notify();
  }

  /**
   * Connect to the extension
   * Returns existing promise if already connecting
   */
  async connect(): Promise<ExtensionConnectionResult> {
    // Already connected
    if (this.state === 'connected' && this.extension) {
      return this.getResult();
    }

    // Already connecting, return existing promise
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.doConnect();
    const result = await this.connectionPromise;
    this.connectionPromise = null;
    return result;
  }

  private async doConnect(): Promise<ExtensionConnectionResult> {
    const { checkTimeout = 100, connectTimeout = 5000 } = this.options;

    // Not in browser
    if (typeof window === 'undefined') {
      this.setState('not-installed');
      return this.getResult();
    }

    // Check if already available
    const win = window as NostrWindow;
    if (win.nostr?.wot) {
      this.setState('connected', win.nostr.wot);
      return this.getResult();
    }

    // Check phase
    this.setState('checking');
    const isInstalled = await checkExtension(checkTimeout);

    if (!isInstalled) {
      this.setState('not-installed');
      return this.getResult();
    }

    // Connect phase
    this.setState('connecting');
    try {
      const extension = await connectExtension(connectTimeout);
      this.setState('connected', extension);
    } catch (error) {
      this.setState(
        'error',
        null,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    return this.getResult();
  }

  /**
   * Reset state and disconnect
   */
  reset() {
    this.state = 'idle';
    this.extension = null;
    this.error = undefined;
    this.connectionPromise = null;
    this.notify();
  }
}

/**
 * Singleton connector instance for convenience
 */
let defaultConnector: ExtensionConnector | null = null;

/**
 * Get the default extension connector
 */
export function getDefaultConnector(
  options?: ExtensionConnectionOptions
): ExtensionConnector {
  if (!defaultConnector) {
    defaultConnector = new ExtensionConnector(options);
  }
  return defaultConnector;
}

/**
 * Reset the default connector (useful for testing)
 */
export function resetDefaultConnector() {
  if (defaultConnector) {
    defaultConnector.reset();
    defaultConnector = null;
  }
}
