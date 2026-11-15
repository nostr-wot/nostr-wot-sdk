import { afterEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { NostrConnect } from "nostr-tools/kinds";
import { v2 as nip44 } from "nostr-tools/nip44";
import { SimplePool } from "nostr-tools/pool";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import * as bunker from "../../src/bunker";
import { TestRelay } from "./relay";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: Record<string, unknown> = {}) {
  const relay = await TestRelay.start();
  cleanups.push(() => relay.close());
  expect(bunker).toHaveProperty("BunkerRelayManager");
  const manager = new bunker.BunkerRelayManager({ reconnectDelayMs: 60, ...options });
  cleanups.push(() => manager.close());
  const users = [getPublicKey(generateSecretKey()), getPublicKey(generateSecretKey())];
  const servers = users.map((user, i) => new bunker.BunkerServer({
    connectionSecretKey: generateSecretKey(), relays: [i ? relay.url.replace(/\/$/, "") : relay.url],
    relayManager: manager, handler: async (req) => req.method === "connect" ? "ack" : user,
  }));
  for (const server of servers) cleanups.push(() => server.stop());
  await Promise.all(servers.map((server) => server.start()));
  return { relay, manager, servers, users };
}

async function client(server: bunker.BunkerServer) {
  const bp = await parseBunkerInput(server.createBunkerUri().uri);
  if (!bp) throw new Error("bad fixture URI");
  const pool = new SimplePool();
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
  cleanups.push(async () => { await signer.close(); pool.close(bp.relays); });
  await signer.connect();
  return signer;
}

describe("shared bunker relays", () => {
  it("normalizes URLs, routes two identities and releases only the departing owner", async () => {
    const { relay, servers, users } = await fixture();
    expect(relay.connections).toBe(1);
    expect(relay.subscriptionCount).toBe(2);
    const clients = await Promise.all(servers.map(client));
    expect(await Promise.all(clients.map((c) => c.getPublicKey()))).toEqual(users);
    await servers[0].stop();
    await expect.poll(() => relay.subscriptionCount).toBe(3); // two client REQs plus remaining server
    expect(await clients[1].getPublicKey()).toBe(users[1]);
    await servers[1].stop();
    await expect.poll(() => relay.connections).toBe(2); // client sockets only
  });

  it("uses one reconnect schedule per URL and restores both subscriptions", async () => {
    const schedules: unknown[] = [];
    const { relay, servers } = await fixture({ logger: { warn: (message: string, meta: unknown) => {
      if (message === "relay subscription closed; retrying") schedules.push(meta);
    } } });
    relay.dropClients();
    await expect.poll(() => schedules.length).toBe(1);
    await Promise.all(servers.map((server) => relay.waitForSubscriber(server.connectionPubkey)));
    expect(relay.connections).toBe(1);
    expect(relay.subscriptionCount).toBe(2);
  });

  it("cancels the central retry when every owner stops", async () => {
    let scheduled = false;
    const { relay, servers, manager } = await fixture({ reconnectDelayMs: 180, logger: { warn: () => { scheduled = true; } } });
    relay.dropClients();
    await expect.poll(() => scheduled).toBe(true);
    await Promise.all(servers.map((server) => server.stop()));
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect(relay.connections).toBe(0);
    expect(relay.subscriptionCount).toBe(0);
    manager.close();
    expect(() => manager.subscribe({}, relay.url, servers[0].connectionPubkey, () => {})).toThrow(/closed/);
  });

  it("enforces one global relay cap and frees capacity when the last owner leaves", async () => {
    const { manager, servers } = await fixture({ maxRelays: 1 });
    const other = await TestRelay.start();
    cleanups.push(() => other.close());
    expect(() => manager.subscribe({}, other.url, servers[0].connectionPubkey, () => {})).toThrow(/limit/);
    await Promise.all(servers.map((s) => s.stop()));
    const subscription = manager.subscribe({}, other.url, servers[0].connectionPubkey, () => {});
    await subscription.ready;
    expect(other.connections).toBe(1);
    subscription.close();
    await expect.poll(() => other.connections).toBe(0);
  });

  it("rejects client-introduced relays before persisting a pairing beyond the global cap", async () => {
    const { manager, servers } = await fixture({ maxRelays: 1 });
    const other = await TestRelay.start();
    cleanups.push(() => other.close());
    const server = servers[0];
    const before = server.exportState();
    const uri = `nostrconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(other.url)}&secret=global-cap`;
    await expect(server.acceptNostrConnect(uri)).rejects.toThrow(/limit/);
    expect(server.exportState()).toEqual(before);
    expect(other.connections).toBe(0);
    expect(() => server.createBunkerUri({ relays: [other.url] })).toThrow(/limit/);
    expect(server.exportState()).toEqual(before);
    manager.close();
  });

  it("retires publish-only sockets and rejects ambiguous pool ownership", async () => {
    const { relay, manager, servers } = await fixture({ maxRelays: 1 });
    const other = await TestRelay.start();
    cleanups.push(() => other.close());
    const event = finalizeEvent({ kind: NostrConnect, content: "reply", tags: [], created_at: Math.floor(Date.now() / 1000) }, generateSecretKey());
    await expect(manager.publish([other.url], event)).rejects.toThrow(/limit/);
    expect(other.connections).toBe(0);
    await Promise.all(servers.map((s) => s.stop()));
    await manager.publish([other.url], event);
    expect(other.received.map((e) => e.id)).toEqual([event.id]);
    await expect.poll(() => other.connections).toBe(0);
    const base = { connectionSecretKey: generateSecretKey(), relays: [relay.url], handler: async () => "ok", relayManager: manager };
    expect(() => new bunker.BunkerServer({ ...base, websocketImplementation: class {} })).toThrow(/relayManager/);
    const pool = new SimplePool();
    expect(() => new bunker.BunkerServer({ ...base, pool })).toThrow(/relayManager/);
    pool.destroy();
  });

  it("does not let an invalid signature poison a genuine request's id", async () => {
    const { relay, servers } = await fixture();
    const server = servers[0];
    const sk = generateSecretKey();
    const request = finalizeEvent({ kind: NostrConnect, created_at: Math.floor(Date.now() / 1000), tags: [["p", server.connectionPubkey]],
      content: nip44.encrypt(JSON.stringify({ id: "valid-after-forgery", method: "ping", params: [] }), nip44.utils.getConversationKey(sk, server.connectionPubkey)),
    }, sk);
    const pool = new SimplePool();
    cleanups.push(() => pool.close([relay.url]));
    await Promise.any(pool.publish([relay.url], { ...request, sig: "0".repeat(128) }));
    await Promise.any(pool.publish([relay.url], request));
    await expect.poll(() => relay.received.filter((event) => event.pubkey === server.connectionPubkey).length).toBe(1);
    const response = relay.received.find((event) => event.pubkey === server.connectionPubkey)!;
    expect(JSON.parse(nip44.decrypt(response.content, nip44.utils.getConversationKey(sk, server.connectionPubkey)))).toEqual({ id: "valid-after-forgery", result: "pong" });
  });

  it("settles startup and retires a socket when closed during the handshake", async () => {
    const relay = await TestRelay.start(0, { acceptDelayMs: 80 });
    cleanups.push(() => relay.close());
    const manager = new bunker.BunkerRelayManager();
    cleanups.push(() => manager.close());
    const subscription = manager.subscribe({}, relay.url, getPublicKey(generateSecretKey()), () => {});
    subscription.close();
    await subscription.ready;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(relay.connections).toBe(0);
    expect(relay.subscriptionCount).toBe(0);
  });

  it("advances authenticated state monotonically while preserving admitted clients", async () => {
    const { servers } = await fixture();
    const server = servers[0];
    await client(server);
    const previous = server.exportState();
    server.advanceGeneration(7);
    expect(server.generation).toBe(7);
    expect(server.exportState().clients).toEqual(previous.clients);
    expect(server.exportState().secrets).toEqual(previous.secrets);
    expect(server.exportState().mac).not.toBe(previous.mac);
    expect(() => server.advanceGeneration(6)).toThrow(/generation/);
    for (const invalid of [-1, NaN, Infinity, 1.5, "8", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => server.advanceGeneration(invalid as number)).toThrow(/generation/);
    }
    server.advanceGeneration(7);
    await expect(server.restore(previous)).rejects.toThrow(/behind/);
    await server.restore(server.exportState());
    expect(server.connectedClients).toEqual(previous.clients.map((c) => c.clientPubkey));
  });
  it("emits the advanced authenticated generation and restores it under the host counter", async () => {
    const sk = generateSecretKey();
    const changes: bunker.BunkerState[] = [];
    const generations: number[] = [];
    const options = { connectionSecretKey: sk, relays: ["wss://relay.example"], handler: async () => "ack" };
    const server = new bunker.BunkerServer({ ...options, generation: 1, onStateChange: (state) => changes.push(state), onGenerationChange: (g) => generations.push(g) });
    cleanups.push(() => server.stop());
    server.createBunkerUri();
    changes.length = 0;
    server.advanceGeneration(3);
    server.advanceGeneration(3);
    expect(generations).toEqual([3]);
    expect(changes).toHaveLength(1);
    expect(changes[0].generation).toBe(3);
    const restored = new bunker.BunkerServer({ ...options, generation: 3 });
    cleanups.push(() => restored.stop());
    await restored.restore(changes[0]);
    expect(restored.exportState()).toEqual(changes[0]);
    restored.revokeSecret(changes[0].secrets[0].secret);
    expect(restored.generation).toBe(4);
  });

});
