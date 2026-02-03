import type { NostrContactEvent } from '../types';
import { RelayError } from '../errors';
import { createDeferred, type Deferred } from '../utils';

/**
 * Nostr relay subscription filter
 */
interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/**
 * Nostr relay message types
 */
type NostrMessage =
  | ['EVENT', string, NostrContactEvent]
  | ['EOSE', string]
  | ['NOTICE', string]
  | ['OK', string, boolean, string];

/**
 * Simple Nostr relay connection for fetching contact lists (kind 3)
 */
export class RelayConnection {
  private url: string;
  private ws: WebSocket | null = null;
  private subscriptions = new Map<
    string,
    {
      filter: NostrFilter;
      events: NostrContactEvent[];
      deferred: Deferred<NostrContactEvent[]>;
    }
  >();
  private connectPromise: Promise<void> | null = null;
  private subIdCounter = 0;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Connect to the relay
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.connectPromise = null;
          resolve();
        };

        this.ws.onerror = (event) => {
          this.connectPromise = null;
          reject(new RelayError(this.url, `Connection error: ${event}`));
        };

        this.ws.onclose = () => {
          this.ws = null;
          this.connectPromise = null;
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as NostrMessage;
            this.handleMessage(message);
          } catch {
            // Ignore malformed messages
          }
        };
      } catch (error) {
        this.connectPromise = null;
        reject(
          new RelayError(
            this.url,
            error instanceof Error ? error.message : 'Connection failed'
          )
        );
      }
    });

    return this.connectPromise;
  }

  /**
   * Handle incoming relay message
   */
  private handleMessage(message: NostrMessage): void {
    const [type, subId] = message;

    if (type === 'EVENT') {
      const event = message[2];
      const sub = this.subscriptions.get(subId);
      if (sub && event.kind === 3) {
        sub.events.push(event);
      }
    } else if (type === 'EOSE') {
      const sub = this.subscriptions.get(subId);
      if (sub) {
        sub.deferred.resolve(sub.events);
        this.subscriptions.delete(subId);
        this.send(['CLOSE', subId]);
      }
    }
  }

  /**
   * Send a message to the relay
   */
  private send(message: unknown[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Fetch contact lists for given pubkeys
   */
  async fetchContactLists(
    pubkeys: string[],
    timeout = 10000
  ): Promise<NostrContactEvent[]> {
    await this.connect();

    const subId = `wot-${++this.subIdCounter}`;
    const filter: NostrFilter = {
      kinds: [3],
      authors: pubkeys,
    };

    const deferred = createDeferred<NostrContactEvent[]>();

    this.subscriptions.set(subId, {
      filter,
      events: [],
      deferred,
    });

    // Send subscription request
    this.send(['REQ', subId, filter]);

    // Set timeout
    const timeoutId = setTimeout(() => {
      const sub = this.subscriptions.get(subId);
      if (sub) {
        sub.deferred.resolve(sub.events);
        this.subscriptions.delete(subId);
        this.send(['CLOSE', subId]);
      }
    }, timeout);

    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Close the relay connection
   */
  close(): void {
    // Close all pending subscriptions
    for (const [subId, sub] of this.subscriptions) {
      sub.deferred.resolve(sub.events);
      this.send(['CLOSE', subId]);
    }
    this.subscriptions.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get relay URL
   */
  getUrl(): string {
    return this.url;
  }
}

/**
 * Pool of relay connections
 */
export class RelayPool {
  private relays: RelayConnection[] = [];
  private connected = false;

  constructor(urls: string[]) {
    this.relays = urls.map((url) => new RelayConnection(url));
  }

  /**
   * Connect to all relays
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const results = await Promise.allSettled(
      this.relays.map((relay) => relay.connect())
    );

    // At least one relay must connect
    const connected = results.filter((r) => r.status === 'fulfilled');
    if (connected.length === 0) {
      throw new RelayError('all', 'Failed to connect to any relay');
    }

    this.connected = true;
  }

  /**
   * Fetch contact lists from all connected relays
   */
  async fetchContactLists(
    pubkeys: string[],
    timeout = 10000
  ): Promise<Map<string, NostrContactEvent>> {
    await this.connect();

    const results = new Map<string, NostrContactEvent>();

    // Fetch from all relays in parallel
    const allEvents = await Promise.all(
      this.relays.map((relay) =>
        relay.fetchContactLists(pubkeys, timeout).catch(() => [])
      )
    );

    // Merge results, keeping the most recent event for each pubkey
    for (const events of allEvents) {
      for (const event of events) {
        const existing = results.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          results.set(event.pubkey, event);
        }
      }
    }

    return results;
  }

  /**
   * Close all relay connections
   */
  close(): void {
    for (const relay of this.relays) {
      relay.close();
    }
    this.relays = [];
    this.connected = false;
  }
}

/**
 * Extract followed pubkeys from a contact list event
 */
export function extractFollows(event: NostrContactEvent): string[] {
  const follows: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] === 'p' && tag[1]) {
      // Validate pubkey format (64 hex chars)
      if (/^[0-9a-f]{64}$/i.test(tag[1])) {
        follows.push(tag[1].toLowerCase());
      }
    }
  }

  return follows;
}
