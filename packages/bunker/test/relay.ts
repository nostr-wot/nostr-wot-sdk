import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { normalizeURL } from "nostr-tools/utils";

interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

interface Event {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function matches(filter: Filter, event: Event): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const key of Object.keys(filter)) {
    if (!key.startsWith("#")) continue;
    const wanted = filter[key as `#${string}`];
    if (!wanted) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && wanted.includes(t[1]))) return false;
  }
  return true;
}

/**
 * A minimal in-process Nostr relay: EVENT / REQ / CLOSE, OK and EOSE. It stores
 * nothing (kind 24133 is ephemeral on real relays too) and fans every accepted
 * event out to every matching subscription, including the sender's own.
 */
export class TestRelay {
  readonly url: string;
  readonly port: number;
  /** Every event the relay accepted, in order. */
  readonly received: Event[] = [];
  #wss: WebSocketServer;
  #subs = new Map<WebSocket, Map<string, Filter[]>>();

  private constructor(wss: WebSocketServer, port: number) {
    this.#wss = wss;
    this.port = port;
    // The pool's spelling of this relay, so assertions against `server.relays` compare like with like.
    this.url = normalizeURL(`ws://127.0.0.1:${port}`);
    wss.on("connection", (socket) => {
      this.#subs.set(socket, new Map());
      socket.on("message", (raw) => this.#onMessage(socket, raw.toString()));
      socket.on("close", () => this.#subs.delete(socket));
    });
  }

  static start(port = 0): Promise<TestRelay> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.once("listening", () => resolve(new TestRelay(wss, (wss.address() as AddressInfo).port)));
      wss.once("error", reject);
    });
  }

  /** Number of currently open client sockets. */
  get connections(): number {
    return this.#wss.clients.size;
  }

  /** Resolves once some socket holds a subscription addressed (`#p`) to `pubkey`. */
  async waitForSubscriber(pubkey: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const subs of this.#subs.values()) {
        for (const filters of subs.values()) {
          if (filters.some((f) => f["#p"]?.includes(pubkey))) return;
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no subscription for ${pubkey} within ${timeoutMs}ms`);
  }

  /** Kill every client socket without stopping the server (a relay hiccup). */
  dropClients(): void {
    for (const socket of this.#wss.clients) socket.terminate();
  }

  /** Stop the server and terminate every socket (a relay going away). */
  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.#wss.clients) socket.terminate();
      this.#wss.close(() => resolve());
    });
  }

  #onMessage(socket: WebSocket, raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [verb] = msg;
    if (verb === "EVENT") {
      const event = msg[1] as Event;
      this.received.push(event);
      socket.send(JSON.stringify(["OK", event.id, true, ""]));
      this.#broadcast(event);
    } else if (verb === "REQ") {
      const subId = msg[1] as string;
      const filters = msg.slice(2) as Filter[];
      this.#subs.get(socket)?.set(subId, filters);
      socket.send(JSON.stringify(["EOSE", subId]));
    } else if (verb === "CLOSE") {
      this.#subs.get(socket)?.delete(msg[1] as string);
    }
  }

  #broadcast(event: Event): void {
    for (const [socket, subs] of this.#subs) {
      for (const [subId, filters] of subs) {
        if (filters.some((f) => matches(f, event))) {
          socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    }
  }
}
