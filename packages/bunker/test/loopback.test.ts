import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";
import { NostrConnect } from "nostr-tools/kinds";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { Nip46Signer, PrivateKeySigner } from "@nostr-wot/signers";
import { BunkerServer, type BunkerHandler, type BunkerRequest } from "../src";
import { TestRelay } from "./relay";

/**
 * Everything below is a real loopback: an in-process relay, the real
 * BunkerServer, and two independent NIP-46 clients (this monorepo's Nip46Signer
 * and nostr-tools' BunkerSigner, the one the browser extension pins). Nothing
 * about the protocol is mocked.
 *
 * The connection key and the user key are DIFFERENT keys throughout, on purpose:
 * the extension's compatibility audit found a shipped bug that a single-key
 * fixture had hidden.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map NIP-46 methods onto a PrivateKeySigner holding the USER key. No policy: the tests wrap it when they need one. */
function signerHandler(user: PrivateKeySigner): BunkerHandler {
  return async (req: BunkerRequest) => {
    switch (req.method) {
      case "connect":
        return "ack";
      case "get_public_key":
        return user.getPublicKey();
      case "sign_event":
        return JSON.stringify(await user.signEvent(JSON.parse(req.params[0]!) as EventTemplate));
      case "nip04_encrypt":
        return user.nip04Encrypt(req.params[0]!, req.params[1]!);
      case "nip04_decrypt":
        return user.nip04Decrypt(req.params[0]!, req.params[1]!);
      case "nip44_encrypt":
        return user.nip44Encrypt(req.params[0]!, req.params[1]!);
      case "nip44_decrypt":
        return user.nip44Decrypt(req.params[0]!, req.params[1]!);
      case "logout":
        return "ack";
      default:
        throw new Error(`unsupported method: ${req.method}`);
    }
  };
}

/** A raw NIP-46 client with no library in between, for the negative-path tests. */
class RawClient {
  readonly sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.sk);
  readonly pool = new SimplePool();
  readonly responses: Array<{ id: string; result?: string; error?: string }> = [];
  #convKey: Uint8Array;
  #closer: { close(): void } | null = null;

  constructor(readonly relays: string[], readonly signerPubkey: string) {
    this.#convKey = nip44.utils.getConversationKey(this.sk, signerPubkey);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.#closer = this.pool.subscribe(
        this.relays,
        { kinds: [NostrConnect], authors: [this.signerPubkey], "#p": [this.pubkey] },
        {
          onevent: (event) => {
            this.responses.push(JSON.parse(nip44.decrypt(event.content, this.#convKey)));
          },
          oneose: () => resolve(),
        },
      );
    });
  }

  async send(id: string, method: string, params: string[]): Promise<void> {
    const event = finalizeEvent(
      {
        kind: NostrConnect,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.signerPubkey]],
        content: nip44.encrypt(JSON.stringify({ id, method, params }), this.#convKey),
      },
      this.sk,
    );
    await Promise.any(this.pool.publish(this.relays, event));
  }

  async waitFor(id: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.responses.find((r) => r.id === id);
      if (hit) return hit;
      await wait(10);
    }
    throw new Error(`no response for ${id}`);
  }

  close(): void {
    this.#closer?.close();
    this.pool.close(this.relays);
  }
}

describe("BunkerServer loopback", () => {
  let relay: TestRelay;
  let server: BunkerServer;
  let connectionSk: Uint8Array;
  let connectionPubkey: string;
  let userSk: Uint8Array;
  let userPubkey: string;
  let user: PrivateKeySigner;
  let handlerCalls: BunkerRequest[];
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    relay = await TestRelay.start();
    connectionSk = generateSecretKey();
    connectionPubkey = getPublicKey(connectionSk);
    userSk = generateSecretKey();
    userPubkey = getPublicKey(userSk);
    expect(userPubkey).not.toBe(connectionPubkey);
    user = new PrivateKeySigner(userSk);
    handlerCalls = [];
    const inner = signerHandler(user);
    server = new BunkerServer({
      connectionSecretKey: connectionSk,
      relays: [relay.url],
      reconnectDelayMs: 100,
      handler: async (req, ctx) => {
        handlerCalls.push(req);
        return inner(req, ctx);
      },
    });
    await server.start();
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    await server.stop();
    await relay.close();
  });

  async function connectWithNip46Signer(uri = server.createBunkerUri().uri): Promise<Nip46Signer> {
    const signer = await Nip46Signer.fromBunkerUri(uri, { relays: [relay.url] });
    cleanups.push(() => signer.close());
    return signer;
  }

  async function connectWithNostrTools(uri = server.createBunkerUri().uri): Promise<BunkerSigner> {
    const bp = await parseBunkerInput(uri);
    if (!bp) throw new Error("bad uri");
    const clientSk = generateSecretKey();
    const pool = new SimplePool();
    const signer = BunkerSigner.fromBunker(clientSk, bp, { pool });
    await signer.connect();
    cleanups.push(async () => {
      await signer.close();
      pool.close(bp.relays);
    });
    return signer;
  }

  describe("bunker:// pairing", () => {
    it("Nip46Signer: get_public_key is the user key, transport is the connection key", async () => {
      const { uri } = server.createBunkerUri();
      expect(uri.startsWith(`bunker://${connectionPubkey}?`)).toBe(true);
      const signer = await connectWithNip46Signer(uri);

      expect(await signer.getPublicKey()).toBe(userPubkey);
      expect(signer.bunkerPubkey).toBe(connectionPubkey);
      // Every event the relay saw from the server is signed by the connection key, never the user key.
      const fromServer = relay.received.filter((e) => e.pubkey === connectionPubkey);
      expect(fromServer.length).toBeGreaterThan(0);
      expect(relay.received.some((e) => e.pubkey === userPubkey)).toBe(false);
      expect(handlerCalls.map((c) => c.method)).toEqual(["connect", "get_public_key"]);
    });

    it("nostr-tools BunkerSigner: the same, against the client the extension pins", async () => {
      const signer = await connectWithNostrTools();
      expect(await signer.getPublicKey()).toBe(userPubkey);
      expect(signer.bp.pubkey).toBe(connectionPubkey);
      expect(relay.received.some((e) => e.pubkey === userPubkey)).toBe(false);
    });

    it("sign_event returns a signature that verifies, authored by the user key", async () => {
      const a = await connectWithNip46Signer();
      const b = await connectWithNostrTools();
      for (const signer of [a, b]) {
        const event = await signer.signEvent({ kind: 1, content: "hello from the bunker", tags: [], created_at: 1_700_000_000 });
        expect(verifyEvent(event)).toBe(true);
        expect(event.pubkey).toBe(userPubkey);
        expect(event.content).toBe("hello from the bunker");
      }
    });

    it("nip04 and nip44 encrypt/decrypt round-trip through both clients", async () => {
      const peerSk = generateSecretKey();
      const peer = new PrivateKeySigner(peerSk);
      const peerPubkey = getPublicKey(peerSk);
      const a = await connectWithNip46Signer();
      const b = await connectWithNostrTools();

      for (const signer of [a, b]) {
        const c04 = await signer.nip04Encrypt(peerPubkey, "nip04 secret");
        expect(await peer.nip04Decrypt(userPubkey, c04)).toBe("nip04 secret");
        expect(await signer.nip04Decrypt(peerPubkey, await peer.nip04Encrypt(userPubkey, "nip04 reply"))).toBe("nip04 reply");

        const c44 = await signer.nip44Encrypt(peerPubkey, "nip44 secret");
        expect(await peer.nip44Decrypt(userPubkey, c44)).toBe("nip44 secret");
        expect(await signer.nip44Decrypt(peerPubkey, await peer.nip44Encrypt(userPubkey, "nip44 reply"))).toBe("nip44 reply");
      }
    });

    it("a wrong pairing secret is refused, and the client stays unconnected", async () => {
      const { uri } = server.createBunkerUri();
      const tampered = uri.replace(/secret=[0-9a-f]+/, "secret=deadbeef");
      const bp = await parseBunkerInput(tampered);
      const pool = new SimplePool();
      const signer = BunkerSigner.fromBunker(generateSecretKey(), bp!, { pool });
      cleanups.push(async () => {
        await signer.close();
        pool.close([relay.url]);
      });
      await expect(signer.connect()).rejects.toBe("invalid secret");
      expect(server.connectedClients).toEqual([]);
      expect(handlerCalls).toEqual([]);
      await expect(signer.getPublicKey()).rejects.toBe("unauthorized: connect first");
    });

    it("a secret is bound to the first client; another client cannot reuse it, the same client can reconnect", async () => {
      const { uri } = server.createBunkerUri();
      const bp = (await parseBunkerInput(uri))!;
      const firstSk = generateSecretKey();
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));

      const first = BunkerSigner.fromBunker(firstSk, bp, { pool });
      await first.connect();
      await first.close();

      const other = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await expect(other.connect()).rejects.toBe("secret already used by another client");
      await other.close();

      const again = BunkerSigner.fromBunker(firstSk, bp, { pool });
      await again.connect();
      expect(await again.getPublicKey()).toBe(userPubkey);
      await again.close();
    });

    it("a request from a client that never connected is answered with an error, not dropped", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      await raw.send("r1", "get_public_key", []);
      expect(await raw.waitFor("r1")).toEqual({ id: "r1", error: "unauthorized: connect first" });
      expect(handlerCalls).toEqual([]);
    });
  });

  describe("nostrconnect:// pairing", () => {
    it("Nip46Signer.startNostrConnect pairs once the server accepts the URI", async () => {
      const handle = Nip46Signer.startNostrConnect({
        relays: [relay.url],
        perms: "sign_event:1,nip44_encrypt",
        metadata: { name: "loopback app", url: "https://example.test" },
      });
      cleanups.push(() => handle.cancel());

      // The user scans the QR after the client is listening; in a loopback we
      // have to wait for that explicitly, the relay keeps nothing.
      await relay.waitForSubscriber(handle.clientPubkey);
      const pairing = await server.acceptNostrConnect(handle.uri);
      expect(pairing.clientPubkey).toBe(handle.clientPubkey);
      expect(pairing.perms).toEqual(["sign_event:1", "nip44_encrypt"]);
      expect(pairing.name).toBe("loopback app");
      const connect = handlerCalls[0]!;
      expect(connect.method).toBe("connect");
      expect(connect.clientPubkey).toBe(handle.clientPubkey);
      expect(connect.params[0]).toBe(connectionPubkey);
      expect(connect.params[2]).toBe("sign_event:1,nip44_encrypt");
      expect(JSON.parse(connect.params[3]!)).toEqual({ name: "loopback app", url: "https://example.test" });

      const signer = await handle.ready;
      expect(signer.bunkerPubkey).toBe(connectionPubkey);
      expect(await signer.getPublicKey()).toBe(userPubkey);
      const signed = await signer.signEvent({ kind: 1, content: "qr", tags: [], created_at: 1_700_000_000 });
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.pubkey).toBe(userPubkey);
    });

    it("nostr-tools BunkerSigner.fromURI pairs against the same acknowledgement", async () => {
      const clientSk = generateSecretKey();
      const pool = new SimplePool();
      const secret = "qr-secret-1234";
      const uri = `nostrconnect://${getPublicKey(clientSk)}?relay=${encodeURIComponent(relay.url)}&secret=${secret}&name=ext`;
      const abort = new AbortController();
      const ready = BunkerSigner.fromURI(clientSk, uri, { pool }, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await ready.then((s) => s.close()).catch(() => {});
        pool.close([relay.url]);
      });

      await relay.waitForSubscriber(getPublicKey(clientSk));
      const pairing = await server.acceptNostrConnect(uri);
      expect(pairing.secret).toBe(secret);
      const signer = await ready;
      expect(signer.bp.pubkey).toBe(connectionPubkey);
      expect(await signer.getPublicKey()).toBe(userPubkey);
    });

    it("a rejected nostrconnect pairing sends nothing and leaves the client unconnected", async () => {
      const clientSk = generateSecretKey();
      const clientPubkey = getPublicKey(clientSk);
      const uri = `nostrconnect://${clientPubkey}?relay=${encodeURIComponent(relay.url)}&secret=nope`;
      const denying = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async () => {
          throw new Error("user declined");
        },
      });
      await denying.start();
      cleanups.push(() => denying.stop());
      const before = relay.received.length;
      await expect(denying.acceptNostrConnect(uri)).rejects.toThrow("user declined");
      expect(denying.isConnected(clientPubkey)).toBe(false);
      expect(relay.received.length).toBe(before);
    });
  });

  describe("request semantics", () => {
    it("a handler rejection surfaces as a NIP-46 error on the same id", async () => {
      const a = await connectWithNip46Signer();
      const b = await connectWithNostrTools();
      const before = handlerCalls.length;
      // The handler throws for methods it does not know.
      await expect(a.signEvent({ kind: 1, content: "", tags: [], created_at: 0 })).resolves.toBeTruthy();
      await expect((b as unknown as { sendRequest(m: string, p: string[]): Promise<string> }).sendRequest("sign_psbt", []))
        .rejects.toBe("unsupported method: sign_psbt");
      expect(handlerCalls.slice(before).map((c) => c.method)).toEqual(["sign_event", "sign_psbt"]);
    });

    it("ping is answered by the transport, logout disconnects", async () => {
      const signer = await connectWithNostrTools();
      await signer.ping();
      expect(handlerCalls.map((c) => c.method)).toEqual(["connect"]);
      await signer.logout();
      expect(server.connectedClients).toEqual([]);
    });

    it("concurrent requests are answered out of order, each on its own id", async () => {
      const slowUser = signerHandler(user);
      const slow = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "sign_event") await wait(400);
          return slowUser(req, ctx);
        },
      });
      await slow.start();
      cleanups.push(() => slow.stop());
      const signer = await Nip46Signer.fromBunkerUri(slow.createBunkerUri().uri);
      cleanups.push(() => signer.close());

      const order: string[] = [];
      const signing = signer.signEvent({ kind: 1, content: "slow", tags: [], created_at: 1 }).then((e) => {
        order.push("sign_event");
        return e;
      });
      await wait(50);
      const pk = await signer.getPublicKey().then((k) => {
        order.push("get_public_key");
        return k;
      });
      const signed = await signing;
      expect(order).toEqual(["get_public_key", "sign_event"]);
      expect(pk).toBe(userPubkey);
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.content).toBe("slow");
    });

    it("a redelivered request (same id, fresh event) is answered exactly once", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      const { secret } = server.createBunkerUri();
      await raw.send("c1", "connect", [connectionPubkey, secret]);
      expect(await raw.waitFor("c1")).toEqual({ id: "c1", result: "ack" });

      await raw.send("dup", "get_public_key", []);
      await raw.send("dup", "get_public_key", []);
      await raw.send("dup", "get_public_key", []);
      await wait(500);
      expect(raw.responses.filter((r) => r.id === "dup")).toEqual([{ id: "dup", result: userPubkey }]);
      expect(handlerCalls.filter((c) => c.method === "get_public_key")).toHaveLength(1);
    });

    it("auth_url goes out on the request id and the real result follows on the same id", async () => {
      const inner = signerHandler(user);
      const challenging = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "sign_event") {
            await ctx.sendAuthUrl("https://bunker.test/approve/1");
            await wait(100);
          }
          return inner(req, ctx);
        },
      });
      await challenging.start();
      cleanups.push(() => challenging.stop());
      const urls: string[] = [];
      const signer = await Nip46Signer.fromBunkerUri(challenging.createBunkerUri().uri, {
        onAuthChallenge: (url) => urls.push(url),
      });
      cleanups.push(() => signer.close());
      const signed = await signer.signEvent({ kind: 1, content: "approved", tags: [], created_at: 1 });
      expect(urls).toEqual(["https://bunker.test/approve/1"]);
      expect(verifyEvent(signed)).toBe(true);
    });

    it("switch_relays answers with the relays the server is actually listening on", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      const { secret } = server.createBunkerUri();
      await raw.send("c1", "connect", [connectionPubkey, secret]);
      await raw.waitFor("c1");
      await raw.send("s1", "switch_relays", []);
      const res = await raw.waitFor("s1");
      expect(JSON.parse(res.result!)).toEqual([relay.url]);
    });
  });

  describe("relay churn", () => {
    it("keeps serving on the surviving relay when one drops, and resumes on the dropped one when it returns", async () => {
      const second = await TestRelay.start();
      server.addRelay(second.url);
      await wait(100);
      const { uri } = server.createBunkerUri({ relays: [relay.url, second.url] });
      const signer = await connectWithNip46Signer(uri);
      expect(await signer.getPublicKey()).toBe(userPubkey);

      const port = second.port;
      await second.close();
      await wait(100);
      // Served via the first relay only.
      const signed = await signer.signEvent({ kind: 1, content: "one relay down", tags: [], created_at: 1 });
      expect(verifyEvent(signed)).toBe(true);

      // The second relay comes back on the same port: the server re-subscribes on its own.
      const revived = await TestRelay.start(port);
      cleanups.push(() => revived.close());
      const deadline = Date.now() + 3000;
      while (revived.connections === 0 && Date.now() < deadline) await wait(50);
      expect(revived.connections).toBeGreaterThan(0);

      // A client that only knows the revived relay is served through it.
      const only = await Nip46Signer.fromBunkerUri(server.createBunkerUri({ relays: [revived.url] }).uri);
      cleanups.push(() => only.close());
      expect(await only.getPublicKey()).toBe(userPubkey);
      expect(revived.received.some((e) => e.pubkey === connectionPubkey)).toBe(true);
    });
  });
});
