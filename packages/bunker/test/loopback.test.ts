import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";
import { NostrConnect } from "nostr-tools/kinds";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { Nip46Signer, PrivateKeySigner } from "@nostr-wot/signers";
import { BunkerError, BunkerServer, type BunkerHandler, type BunkerRequest, type BunkerState } from "../src";
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
        throw new BunkerError(`unsupported method: ${req.method}`);
    }
  };
}

/** A promise the test settles by hand, for ordering without sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  build(
    id: string,
    method: string,
    params: string[],
    opts: { convKey?: Uint8Array; createdAt?: number } = {},
  ) {
    return finalizeEvent(
      {
        kind: NostrConnect,
        created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
        tags: [["p", this.signerPubkey]],
        content: nip44.encrypt(JSON.stringify({ id, method, params }), opts.convKey ?? this.#convKey),
      },
      this.sk,
    );
  }

  async publish(event: ReturnType<RawClient["build"]>, relays: string[] = this.relays): Promise<void> {
    await Promise.any(this.pool.publish(relays, event));
  }

  async send(
    id: string,
    method: string,
    params: string[],
    opts: { convKey?: Uint8Array; createdAt?: number } = {},
  ): Promise<void> {
    const event = finalizeEvent(
      {
        kind: NostrConnect,
        created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
        tags: [["p", this.signerPubkey]],
        content: nip44.encrypt(JSON.stringify({ id, method, params }), opts.convKey ?? this.#convKey),
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
          throw new BunkerError("user declined");
        },
      });
      await denying.start();
      cleanups.push(() => denying.stop());
      const before = relay.received.length;
      await expect(denying.acceptNostrConnect(uri)).rejects.toThrow("user declined");
      expect(denying.isConnected(clientPubkey)).toBe(false);
      expect(relay.received.length).toBe(before);
    });

    it("an auth_url during a nostrconnect approval reaches the client's relay and never the host's", async () => {
      const clientRelay = await TestRelay.start();
      cleanups.push(() => clientRelay.close());
      const authUrl = "https://bunker.test/approve/qr";
      const challenging = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "connect") await ctx.sendAuthUrl(authUrl);
          return signerHandler(user)(req, ctx);
        },
      });
      await challenging.start();
      cleanups.push(() => challenging.stop());

      const aSk = generateSecretKey();
      const aPubkey = getPublicKey(aSk);
      const aPool = new SimplePool();
      const uri = `nostrconnect://${aPubkey}?relay=${encodeURIComponent(clientRelay.url)}&secret=qr-auth`;
      const abort = new AbortController();
      const ready = BunkerSigner.fromURI(aSk, uri, { pool: aPool }, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await ready.then((s) => s.close()).catch(() => {});
        aPool.close([clientRelay.url]);
      });
      await clientRelay.waitForSubscriber(aPubkey);
      await challenging.acceptNostrConnect(uri);
      const a = await ready;
      expect(await a.getPublicKey()).toBe(userPubkey);

      const toA = (e: { tags: string[][] }) => e.tags.some((t) => t[0] === "p" && t[1] === aPubkey);
      const fromServerToA = clientRelay.received.filter((e) => e.pubkey === challenging.connectionPubkey && toA(e));
      const convKey = nip44.utils.getConversationKey(aSk, challenging.connectionPubkey);
      const payloads = fromServerToA.map((e) => JSON.parse(nip44.decrypt(e.content, convKey)));
      expect(payloads[0]).toEqual({ id: payloads[0].id, result: "auth_url", error: authUrl });
      expect(payloads[1]).toEqual({ id: payloads[0].id, result: "qr-auth" });
      expect(relay.received.filter(toA)).toEqual([]);
    });

    it("a rejected nostrconnect scan leaves no trace on a host-minted secret's relays", async () => {
      const strangerRelay = await TestRelay.start();
      cleanups.push(() => strangerRelay.close());
      const strangerPubkey = getPublicKey(generateSecretKey());
      const picky = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "connect" && req.clientPubkey === strangerPubkey) throw new BunkerError("user declined");
          return signerHandler(user)(req, ctx);
        },
      });
      await picky.start();
      cleanups.push(() => picky.stop());
      const { secret } = picky.createBunkerUri(); // host-minted, advertised on the host relay

      // A stranger who learned the secret gets their nostrconnect scan rejected.
      const strangerUri = `nostrconnect://${strangerPubkey}?relay=${encodeURIComponent(strangerRelay.url)}&secret=${secret}`;
      await expect(picky.acceptNostrConnect(strangerUri)).rejects.toThrow("user declined");

      // The legitimate client then connects with the same secret over the host relay.
      const b = new RawClient([relay.url], picky.connectionPubkey);
      cleanups.push(() => b.close());
      await b.listen();
      await b.send("cb", "connect", [picky.connectionPubkey, secret]);
      expect(await b.waitFor("cb", 1500)).toEqual({ id: "cb", result: "ack" });
      expect(picky.relaysFor(b.pubkey)).toEqual([relay.url]);
      expect(picky.listeningRelays).toEqual([relay.url]);
      const toB = (e: { tags: string[][] }) => e.tags.some((t) => t[0] === "p" && t[1] === b.pubkey);
      expect(strangerRelay.received.filter(toB)).toEqual([]);
    });

    it("an auth_url to a relay of a rejected scan leaves no socket behind, and stop() closes every socket", async () => {
      const strangerRelay = await TestRelay.start();
      cleanups.push(() => strangerRelay.close());
      const settled = async (predicate: () => boolean, ms = 2000) => {
        const deadline = Date.now() + ms;
        while (!predicate() && Date.now() < deadline) await wait(20);
        return predicate();
      };

      // Rejected after an auth_url: the socket the auth_url opened must go away with the record.
      const rejecting = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method !== "connect") return signerHandler(user)(req, ctx);
          await ctx.sendAuthUrl("https://bunker.test/approve/stranger");
          throw new BunkerError("user declined");
        },
      });
      await rejecting.start();
      cleanups.push(() => rejecting.stop());
      const uri1 = `nostrconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(strangerRelay.url)}&secret=s1`;
      await expect(rejecting.acceptNostrConnect(uri1)).rejects.toThrow("user declined");
      expect(strangerRelay.received).toHaveLength(1); // the auth_url did go out
      expect(await settled(() => strangerRelay.connections === 0)).toBe(true);

      // Still pending at stop(): stop() must close the socket the auth_url opened, not only the host relays.
      const hanging = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handlerTimeoutMs: 0,
        handler: async (req, ctx) => {
          if (req.method !== "connect") return signerHandler(user)(req, ctx);
          await ctx.sendAuthUrl("https://bunker.test/approve/slow");
          return new Promise<string>(() => {});
        },
      });
      await hanging.start();
      const uri2 = `nostrconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(strangerRelay.url)}&secret=s2`;
      void hanging.acceptNostrConnect(uri2).catch(() => {});
      expect(await settled(() => strangerRelay.received.length === 2)).toBe(true);
      expect(await settled(() => strangerRelay.connections === 1, 500)).toBe(true);
      await hanging.stop();
      expect(await settled(() => strangerRelay.connections === 0)).toBe(true);

      // Host-minted secret this time: the record survives the rejection, the socket must not.
      const hostMinted = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method !== "connect") return signerHandler(user)(req, ctx);
          await ctx.sendAuthUrl("https://bunker.test/approve/host-minted");
          throw new BunkerError("user declined");
        },
      });
      await hostMinted.start();
      cleanups.push(() => hostMinted.stop());
      const { secret } = hostMinted.createBunkerUri();
      const uri3 = `nostrconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(strangerRelay.url)}&secret=${secret}`;
      await expect(hostMinted.acceptNostrConnect(uri3)).rejects.toThrow("user declined");
      expect(strangerRelay.received).toHaveLength(3);
      expect(await settled(() => strangerRelay.connections === 0)).toBe(true);
    });

    it("two concurrent acceptNostrConnect calls with one secret admit exactly one client", async () => {
      const gates = new Map<string, ReturnType<typeof deferred<string>>>();
      const aPubkey = getPublicKey(generateSecretKey());
      const bPubkey = getPublicKey(generateSecretKey());
      const racing = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method !== "connect") return signerHandler(user)(req, ctx);
          if (req.clientPubkey === bPubkey) return "ack"; // the intruder's approval is instant
          const gate = deferred<string>();
          gates.set(req.clientPubkey, gate);
          return gate.promise;
        },
      });
      await racing.start();
      cleanups.push(() => racing.stop());
      const uriFor = (pk: string) => `nostrconnect://${pk}?relay=${encodeURIComponent(relay.url)}&secret=shared-secret`;

      const acceptA = racing.acceptNostrConnect(uriFor(aPubkey));
      const deadline = Date.now() + 3000;
      while (!gates.has(aPubkey) && Date.now() < deadline) await wait(10);
      expect(gates.has(aPubkey)).toBe(true); // A's approval is pending
      await expect(racing.acceptNostrConnect(uriFor(bPubkey))).rejects.toThrow("secret already in use");
      gates.get(aPubkey)!.resolve("ack");
      await acceptA;
      expect(racing.connectedClients).toEqual([aPubkey]);
    });
  });

  describe("request semantics", () => {
    it("a handler rejection surfaces as a NIP-46 error on the same id", async () => {
      const a = await connectWithNip46Signer();
      const b = await connectWithNostrTools();
      const before = handlerCalls.length;
      const signed = await a.signEvent({ kind: 1, content: "still fine", tags: [], created_at: 0 });
      expect(signed.pubkey).toBe(userPubkey);
      expect(verifyEvent(signed)).toBe(true);
      // The handler throws a BunkerError for methods it does not know: its text is wire-visible.
      await expect((b as unknown as { sendRequest(m: string, p: string[]): Promise<string> }).sendRequest("sign_psbt", []))
        .rejects.toBe("unsupported method: sign_psbt");
      expect(handlerCalls.slice(before).map((c) => c.method)).toEqual(["sign_event", "sign_psbt"]);
    });

    it("a plain Error thrown by the handler never reaches the wire; BunkerError and mapError do", async () => {
      const inner = signerHandler(user);
      const leaky = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "nip04_encrypt") throw new Error("keychain: item 0x1f locked, owner leon@example");
          return inner(req, ctx);
        },
      });
      await leaky.start();
      cleanups.push(() => leaky.stop());
      const signer = await connectWithNip46Signer(leaky.createBunkerUri().uri);
      // The README's handler shape, fed a non-JSON param: the parser's message must not leak either.
      const rawErr = await signer.signEvent("not json {{" as unknown as EventTemplate).catch((e) => e);
      expect(rawErr).toBe("request rejected");
      await expect(signer.nip04Encrypt(userPubkey, "x")).rejects.toBe("request rejected");

      const mapped = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async () => {
          throw new Error("internal detail");
        },
        mapError: (err, req) => `refused ${req.method} (${err instanceof Error ? "error" : "other"})`,
      });
      await mapped.start();
      cleanups.push(() => mapped.stop());
      const { uri } = mapped.createBunkerUri();
      const bp = (await parseBunkerInput(uri))!;
      const pool = new SimplePool();
      const s2 = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      cleanups.push(async () => {
        await s2.close();
        pool.close([relay.url]);
      });
      await expect(s2.connect()).rejects.toBe("refused connect (error)");
    });

    it("a handler that never settles is answered with a timeout error", async () => {
      const inner = signerHandler(user);
      const stuck = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handlerTimeoutMs: 200,
        handler: (req, ctx) => (req.method === "sign_event" ? new Promise<string>(() => {}) : inner(req, ctx)),
      });
      await stuck.start();
      cleanups.push(() => stuck.stop());
      const signer = await connectWithNip46Signer(stuck.createBunkerUri().uri);
      const started = Date.now();
      await expect(signer.signEvent({ kind: 1, content: "", tags: [], created_at: 1 })).rejects.toBe("request timed out");
      expect(Date.now() - started).toBeGreaterThanOrEqual(180);
      expect(await signer.getPublicKey()).toBe(userPubkey);
    });

    it("ping is answered by the transport, before and after connect; logout disconnects", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      await raw.send("p0", "ping", []);
      expect(await raw.waitFor("p0")).toEqual({ id: "p0", result: "pong" });

      const signer = await connectWithNostrTools();
      await signer.ping();
      expect(handlerCalls.map((c) => c.method)).toEqual(["connect"]);
      await signer.logout();
      expect(server.connectedClients).toEqual([]);
    });

    it("requireSecret: false forwards a secretless connect to the handler, which owns admission", async () => {
      const inner = signerHandler(user);
      const calls: BunkerRequest[] = [];
      const open = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        requireSecret: false,
        handler: async (req, ctx) => {
          calls.push(req);
          if (req.method === "connect" && req.params[3]?.includes("blocked")) throw new BunkerError("not on the list");
          return inner(req, ctx);
        },
      });
      await open.start();
      cleanups.push(() => open.stop());
      const bp = { pubkey: open.connectionPubkey, relays: [relay.url], secret: null };
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));

      const allowed = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await allowed.connect();
      expect(await allowed.getPublicKey()).toBe(userPubkey);
      expect(open.relaysFor(getPublicKey((allowed as unknown as { secretKey: Uint8Array }).secretKey))).toEqual([relay.url]);
      await allowed.close();

      const blocked = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await expect(blocked.connect({ name: "blocked app" })).rejects.toBe("not on the list");
      await expect(blocked.getPublicKey()).rejects.toBe("unauthorized: connect first");
      await blocked.close();
      expect(calls.filter((c) => c.method === "connect")).toHaveLength(2);
      expect(calls[0]!.params[1]).toBe("");
    });

    it("concurrent requests are answered out of order, each on its own id", async () => {
      const slowUser = signerHandler(user);
      const gate = deferred<void>();
      const signEntered = deferred<void>();
      const slow = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "sign_event") {
            signEntered.resolve();
            await gate.promise; // held open until the test says so
          }
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
      await signEntered.promise; // sign_event is now blocked inside the handler
      const pk = await signer.getPublicKey().then((k) => {
        order.push("get_public_key");
        return k;
      });
      expect(order).toEqual(["get_public_key"]);
      gate.resolve();
      const signed = await signing;
      expect(order).toEqual(["get_public_key", "sign_event"]);
      expect(pk).toBe(userPubkey);
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.content).toBe("slow");
    });

    it("two clients racing the same secret while approval is pending: exactly one gets in", async () => {
      const inner = signerHandler(user);
      const gate = deferred<void>();
      const racing = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "connect") await gate.promise;
          return inner(req, ctx);
        },
      });
      await racing.start();
      cleanups.push(() => racing.stop());
      const { secret } = racing.createBunkerUri();
      const a = new RawClient([relay.url], racing.connectionPubkey);
      const b = new RawClient([relay.url], racing.connectionPubkey);
      cleanups.push(() => a.close(), () => b.close());
      await Promise.all([a.listen(), b.listen()]);

      await a.send("ca", "connect", [racing.connectionPubkey, secret]);
      await wait(50); // a's connect is now pending inside the handler
      await b.send("cb", "connect", [racing.connectionPubkey, secret]);
      expect(await b.waitFor("cb")).toEqual({ id: "cb", error: "secret already used by another client" });
      gate.resolve();
      expect(await a.waitFor("ca")).toEqual({ id: "ca", result: "ack" });
      expect(racing.connectedClients).toEqual([a.pubkey]);
    });

    it("a secret whose pending connect was rejected is free again for the next client", async () => {
      const inner = signerHandler(user);
      let denyNext = true;
      const picky = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "connect" && denyNext) {
            denyNext = false;
            throw new BunkerError("user declined");
          }
          return inner(req, ctx);
        },
      });
      await picky.start();
      cleanups.push(() => picky.stop());
      const { uri } = picky.createBunkerUri();
      const bp = (await parseBunkerInput(uri))!;
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));
      const first = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await expect(first.connect()).rejects.toBe("user declined");
      await first.close();
      const second = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await second.connect();
      expect(await second.getPublicKey()).toBe(userPubkey);
      await second.close();
    });

    it("rejecting one of a client's two pending connects does not free the secret for another client", async () => {
      const gates = new Map<string, ReturnType<typeof deferred<string>>>();
      const racing = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req) => {
          if (req.method !== "connect") return signerHandler(user)(req, {} as never);
          if (req.clientPubkey === b.pubkey) return "ack"; // the intruder's approval is instant
          const gate = deferred<string>();
          gates.set(req.id, gate);
          return gate.promise;
        },
      });
      await racing.start();
      cleanups.push(() => racing.stop());
      const { secret } = racing.createBunkerUri();
      const a = new RawClient([relay.url], racing.connectionPubkey);
      const b = new RawClient([relay.url], racing.connectionPubkey);
      cleanups.push(() => a.close(), () => b.close());
      await Promise.all([a.listen(), b.listen()]);
      const untilGate = async (id: string) => {
        const deadline = Date.now() + 3000;
        while (!gates.has(id) && Date.now() < deadline) await wait(10);
        expect(gates.has(id)).toBe(true);
      };

      await a.send("ca1", "connect", [racing.connectionPubkey, secret]);
      await untilGate("ca1");
      await a.send("ca2", "connect", [racing.connectionPubkey, secret]);
      await untilGate("ca2");
      gates.get("ca1")!.reject(new BunkerError("user declined"));
      expect(await a.waitFor("ca1")).toEqual({ id: "ca1", error: "user declined" });

      await b.send("cb", "connect", [racing.connectionPubkey, secret]);
      expect(await b.waitFor("cb")).toEqual({ id: "cb", error: "secret already used by another client" });

      gates.get("ca2")!.resolve("ack");
      expect(await a.waitFor("ca2")).toEqual({ id: "ca2", result: "ack" });
      expect(racing.connectedClients).toEqual([a.pubkey]);
    });

    it("a response that lands after logout is dropped rather than re-opening the released relay", async () => {
      const clientRelay = await TestRelay.start();
      cleanups.push(() => clientRelay.close());
      const gate = deferred<void>();
      const signEntered = deferred<void>();
      const slow = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: async (req, ctx) => {
          if (req.method === "sign_event") {
            signEntered.resolve();
            await gate.promise;
          }
          return signerHandler(user)(req, ctx);
        },
      });
      await slow.start();
      cleanups.push(() => slow.stop());

      const aSk = generateSecretKey();
      const aPool = new SimplePool();
      const uri = `nostrconnect://${getPublicKey(aSk)}?relay=${encodeURIComponent(clientRelay.url)}&secret=late`;
      const abort = new AbortController();
      const ready = BunkerSigner.fromURI(aSk, uri, { pool: aPool, skipSwitchRelays: true } as never, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await ready.then((s) => s.close()).catch(() => {});
        aPool.close([clientRelay.url]);
      });
      await clientRelay.waitForSubscriber(getPublicKey(aSk));
      await slow.acceptNostrConnect(uri);
      const a = await ready;

      const pending = a.signEvent({ kind: 1, content: "in flight", tags: [], created_at: 1 }).catch(() => null);
      await signEntered.promise;
      await a.logout();
      expect(slow.listeningRelays).toEqual([relay.url]);
      const seenSoFar = clientRelay.received.length;

      gate.resolve();
      await wait(300);
      expect(clientRelay.received.length).toBe(seenSoFar);
      expect(clientRelay.connections).toBeLessThanOrEqual(1); // A's own pool socket at most, never the server's
      void pending;
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

    it("a request encrypted to the wrong key is dropped without a response or a handler call", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      const { secret } = server.createBunkerUri();
      await raw.send("c1", "connect", [connectionPubkey, secret]);
      await raw.waitFor("c1");
      const wrongKey = nip44.utils.getConversationKey(raw.sk, getPublicKey(generateSecretKey()));
      await raw.send("w1", "get_public_key", [], { convKey: wrongKey });
      await raw.send("ok1", "ping", []);
      await raw.waitFor("ok1");
      expect(raw.responses.find((r) => r.id === "w1")).toBeUndefined();
      expect(handlerCalls.map((c) => c.method)).toEqual(["connect"]);
    });

    it("a request outside the clock-skew limit is dropped", async () => {
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      const { secret } = server.createBunkerUri();
      await raw.send("c1", "connect", [connectionPubkey, secret]);
      await raw.waitFor("c1");
      const now = Math.floor(Date.now() / 1000);
      await raw.send("old", "get_public_key", [], { createdAt: now - 3600 });
      await raw.send("future", "get_public_key", [], { createdAt: now + 3600 });
      await raw.send("ok1", "ping", []);
      await raw.waitFor("ok1");
      expect(raw.responses.filter((r) => r.id === "old" || r.id === "future")).toEqual([]);
      expect(handlerCalls.map((c) => c.method)).toEqual(["connect"]);
    });

    it("a flood of strangers cannot evict a connected client's replay window", async () => {
      // seenCapacity: 64 is the same knob the original single global window used, so 200
      // junk events are three times what a shared window can hold. A per-client window
      // keeps the client's own ids regardless of how many strangers show up.
      const bounded = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        seenCapacity: 64,
        handler: async (req, ctx) => {
          handlerCalls.push(req);
          return signerHandler(user)(req, ctx);
        },
      });
      await bounded.start();
      cleanups.push(() => bounded.stop());
      const raw = new RawClient([relay.url], bounded.connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      const { secret } = bounded.createBunkerUri();
      await raw.send("c1", "connect", [bounded.connectionPubkey, secret]);
      await raw.waitFor("c1");
      await raw.send("once", "get_public_key", []);
      expect(await raw.waitFor("once")).toEqual({ id: "once", result: userPubkey });

      // Anyone can encrypt to the server's public key, so the junk is 200 well-formed
      // requests from 200 fresh keypairs: exactly what reaches the request-id window.
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));
      const accepted: Promise<unknown>[] = [];
      for (let i = 0; i < 200; i++) {
        const sk = generateSecretKey();
        const convKey = nip44.utils.getConversationKey(sk, bounded.connectionPubkey);
        const junk = finalizeEvent(
          {
            kind: NostrConnect,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["p", bounded.connectionPubkey]],
            content: nip44.encrypt(JSON.stringify({ id: `junk-${i}`, method: "ping", params: [] }), convKey),
          },
          sk,
        );
        accepted.push(Promise.any(pool.publish([relay.url], junk)));
      }
      await Promise.all(accepted); // every junk request is in the relay before the replay
      await raw.send("once", "get_public_key", []); // the same request id again, a fresh event
      await raw.send("after", "ping", []);
      await raw.waitFor("after");
      expect(raw.responses.filter((r) => r.id === "once")).toHaveLength(1);
      expect(handlerCalls.filter((c) => c.method === "get_public_key")).toHaveLength(1);
    }, 15_000);

    it("one request id from two different senders is answered for both", async () => {
      const a = new RawClient([relay.url], connectionPubkey);
      const b = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => a.close(), () => b.close());
      await Promise.all([a.listen(), b.listen()]);
      await a.send("c", "connect", [connectionPubkey, server.createBunkerUri().secret]);
      await b.send("c", "connect", [connectionPubkey, server.createBunkerUri().secret]);
      expect(await a.waitFor("c")).toEqual({ id: "c", result: "ack" });
      expect(await b.waitFor("c")).toEqual({ id: "c", result: "ack" });
      await a.send("same", "get_public_key", []);
      await b.send("same", "get_public_key", []);
      expect(await a.waitFor("same")).toEqual({ id: "same", result: userPubkey });
      expect(await b.waitFor("same")).toEqual({ id: "same", result: userPubkey });
      expect(handlerCalls.filter((c) => c.method === "get_public_key")).toHaveLength(2);
    });

    it("a forged event carrying a genuine request's id, delivered first on the same relay, cannot suppress the genuine request", async () => {
      // The forgery needs no valid signature, only the right 64 hex characters in `id`.
      // nostr-tools' pool records that id as seen before it verifies anything, so
      // through the pool's own subscription the genuine event is dropped as a duplicate.
      const raw = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      await raw.send("c1", "connect", [connectionPubkey, server.createBunkerUri().secret]);
      await raw.waitFor("c1");

      const genuine = raw.build("v1", "get_public_key", []);
      const forged = { ...genuine, sig: genuine.sig.slice(0, -2) + (genuine.sig.endsWith("00") ? "11" : "00") };
      await raw.publish(forged as typeof genuine);
      await wait(50); // the forgery is in first
      await raw.publish(genuine);
      expect(await raw.waitFor("v1", 1500)).toEqual({ id: "v1", result: userPubkey });
      expect(handlerCalls.filter((c) => c.method === "get_public_key")).toHaveLength(1);

      // And the same forgery, then the genuine event, from a second relay in the client's set.
      const honest = await TestRelay.start();
      cleanups.push(() => honest.close());
      server.addRelay(honest.url);
      await wait(100);
      const raw2 = new RawClient([relay.url, honest.url], connectionPubkey);
      cleanups.push(() => raw2.close());
      await raw2.listen();
      await raw2.send("c2", "connect", [connectionPubkey, server.createBunkerUri({ relays: [relay.url, honest.url] }).secret]);
      await raw2.waitFor("c2");
      const genuine2 = raw2.build("v2", "get_public_key", []);
      const forged2 = { ...genuine2, sig: forged.sig };
      await raw2.publish(forged2 as typeof genuine2, [relay.url]);
      await wait(50);
      await raw2.publish(genuine2, [honest.url]);
      expect(await raw2.waitFor("v2", 1500)).toEqual({ id: "v2", result: userPubkey });
    });

    it("with an injected pool that does not verify, #onEvent's own check still gates both dispatch and dedup", async () => {
      // SimplePool spreads its options over verifyEvent, so a non-verifying pool is a supported
      // configuration. Through such a pool the relay-level check at abstract-relay.js:480 passes
      // everything, and #onEvent's verifyEvent is the only thing between a forgery and the handler.
      const pool = new SimplePool({ verifyEvent: () => true });
      cleanups.push(() => pool.close([relay.url]));
      const calls: BunkerRequest[] = [];
      const lax = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        pool,
        handler: async (req, ctx) => {
          calls.push(req);
          return signerHandler(user)(req, ctx);
        },
      });
      await lax.start();
      cleanups.push(() => lax.stop());
      const raw = new RawClient([relay.url], lax.connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      await raw.send("c1", "connect", [lax.connectionPubkey, lax.createBunkerUri().secret]);
      await raw.waitFor("c1");

      const genuine = raw.build("v1", "get_public_key", []);
      const forged = { ...genuine, sig: genuine.sig.slice(0, -2) + (genuine.sig.endsWith("00") ? "11" : "00") };
      await raw.publish(forged as typeof genuine);
      await wait(150);
      // Not dispatched: a broken signature must never reach the handler.
      expect(raw.responses.find((r) => r.id === "v1")).toBeUndefined();
      expect(calls.filter((c) => c.method === "get_public_key")).toHaveLength(0);
      // Not remembered either: the genuine event must still be answered.
      await raw.publish(genuine);
      expect(await raw.waitFor("v1", 1500)).toEqual({ id: "v1", result: userPubkey });
      expect(calls.filter((c) => c.method === "get_public_key")).toHaveLength(1);
    });

    it("a signature-corrupted copy from a malicious relay cannot suppress the genuine request from an honest one", async () => {
      // Two relays in the client's set: the server holds one subscription per relay, so a
      // corrupted copy on one and the genuine event on the other both reach the server.
      // (On a single relay nostr-tools' own per-subscription id set drops the second copy
      // before verification; that is the upstream issue recorded in the report.)
      const malicious = relay;
      const honest = await TestRelay.start();
      cleanups.push(() => honest.close());
      const { uri, secret } = server.createBunkerUri({ relays: [malicious.url, honest.url] });
      expect(uri).toContain(encodeURIComponent(honest.url));
      const raw = new RawClient([malicious.url, honest.url], connectionPubkey);
      cleanups.push(() => raw.close());
      await raw.listen();
      await raw.send("c1", "connect", [connectionPubkey, secret]);
      await raw.waitFor("c1");

      const genuine = raw.build("v1", "get_public_key", []);
      const corrupted = { ...genuine, sig: genuine.sig.slice(0, -2) + (genuine.sig.endsWith("00") ? "11" : "00") };
      await raw.publish(corrupted as typeof genuine, [malicious.url]);
      await wait(50); // the malicious relay wins the race
      await raw.publish(genuine, [honest.url]);
      expect(await raw.waitFor("v1", 1500)).toEqual({ id: "v1", result: userPubkey });
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

  describe("relay privacy", () => {
    it("a relay one client introduced never carries another client's traffic", async () => {
      const attackerRelay = await TestRelay.start();
      cleanups.push(() => attackerRelay.close());

      // Client A pairs via nostrconnect:// naming only the attacker's relay.
      const aSk = generateSecretKey();
      const aPubkey = getPublicKey(aSk);
      const aPool = new SimplePool();
      const aUri = `nostrconnect://${aPubkey}?relay=${encodeURIComponent(attackerRelay.url)}&secret=a-secret`;
      const abort = new AbortController();
      const aReady = BunkerSigner.fromURI(aSk, aUri, { pool: aPool }, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await aReady.then((s) => s.close()).catch(() => {});
        aPool.close([attackerRelay.url]);
      });
      await attackerRelay.waitForSubscriber(aPubkey);
      await server.acceptNostrConnect(aUri);
      const a = await aReady;
      expect(await a.getPublicKey()).toBe(userPubkey);
      expect(server.relaysFor(aPubkey)).toEqual([attackerRelay.url]);
      expect(server.relays).toEqual([relay.url]); // host relays untouched
      expect(server.listeningRelays.sort()).toEqual([relay.url, attackerRelay.url].sort());

      // Client B pairs via bunker:// on the host relay and asks where to go.
      const b = await connectWithNostrTools();
      const bPubkey = getPublicKey((b as unknown as { secretKey: Uint8Array }).secretKey);
      const switched = JSON.parse(await (b as unknown as { sendRequest(m: string, p: string[]): Promise<string> }).sendRequest("switch_relays", []));
      expect(switched).toEqual([relay.url]);
      expect(await b.getPublicKey()).toBe(userPubkey);
      const signed = await b.signEvent({ kind: 1, content: "private", tags: [], created_at: 1 });
      expect(signed.pubkey).toBe(userPubkey);

      const toB = (e: { tags: string[][] }) => e.tags.some((t) => t[0] === "p" && t[1] === bPubkey);
      const toA = (e: { tags: string[][] }) => e.tags.some((t) => t[0] === "p" && t[1] === aPubkey);
      expect(attackerRelay.received.filter(toB)).toEqual([]);
      expect(attackerRelay.received.some(toA)).toBe(true);
      expect(relay.received.filter(toA)).toEqual([]);

      // A's switch_relays is A's own set, and A leaving drops the relay it brought.
      const aSwitched = JSON.parse(await (a as unknown as { sendRequest(m: string, p: string[]): Promise<string> }).sendRequest("switch_relays", []));
      expect(aSwitched).toEqual([attackerRelay.url]);
      await a.logout();
      expect(server.listeningRelays).toEqual([relay.url]);
      const deadline = Date.now() + 2000;
      while (attackerRelay.connections > 1 && Date.now() < deadline) await wait(20);
      expect(attackerRelay.connections).toBeLessThanOrEqual(1); // only A's own pool socket, if it is still open
    });

    it("two spellings of one relay are one relay: a client's logout does not close another client's socket", async () => {
      const port = relay.port;
      const spellings = [`ws://127.0.0.1:${port}`, `WS://127.0.0.1:${port}/`, `ws://127.0.0.1:${port}//`];
      expect(spellings).not.toContain(relay.url); // none is the pool's own spelling

      const b = new RawClient([relay.url], connectionPubkey);
      cleanups.push(() => b.close());
      await b.listen();
      await b.send("cb", "connect", [connectionPubkey, server.createBunkerUri().secret]);
      await b.waitFor("cb");

      const aSk = generateSecretKey();
      const aPubkey = getPublicKey(aSk);
      const aPool = new SimplePool();
      const query = spellings.map((u) => `relay=${encodeURIComponent(u)}`).join("&");
      const uri = `nostrconnect://${aPubkey}?${query}&secret=spelled`;
      const abort = new AbortController();
      const ready = BunkerSigner.fromURI(aSk, uri, { pool: aPool }, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await ready.then((s) => s.close()).catch(() => {});
        aPool.close(spellings);
      });
      await relay.waitForSubscriber(aPubkey);
      const pairing = await server.acceptNostrConnect(uri);
      expect(pairing.relays).toEqual([relay.url]);
      const a = await ready;
      expect(await a.getPublicKey()).toBe(userPubkey);
      expect(server.relaysFor(aPubkey)).toEqual([relay.url]);
      expect(server.listeningRelays).toEqual([relay.url]);
      expect(relay.connections).toBe(3); // server, A, B: one server socket, not one per spelling

      await a.logout();
      expect(server.listeningRelays).toEqual([relay.url]);
      await b.send("still-here", "ping", []);
      expect(await b.waitFor("still-here", 800)).toEqual({ id: "still-here", result: "pong" });
      expect(server.connectedClients).toEqual([b.pubkey]);
    });

    it("a scanned nostrconnect URI cannot rebind a secret already bound to another client", async () => {
      const { uri, secret } = server.createBunkerUri();
      const first = await connectWithNostrTools(uri);
      expect(await first.getPublicKey()).toBe(userPubkey);
      const intruder = `nostrconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(relay.url)}&secret=${secret}`;
      await expect(server.acceptNostrConnect(intruder)).rejects.toThrow("secret already in use");
      expect(handlerCalls.filter((c) => c.method === "connect")).toHaveLength(1);
    });
  });

  describe("subscription lifecycle", () => {
    it("a relay asked for again while it is still connecting gets one REQ, not one per request", async () => {
      const slow = await TestRelay.start(0, { acceptDelayMs: 300 });
      cleanups.push(() => slow.close());
      const one = new BunkerServer({ connectionSecretKey: generateSecretKey(), relays: [slow.url], handler: signerHandler(user) });
      cleanups.push(() => one.stop());
      const starting = one.start();
      one.addRelay(slow.url); // same relay, different call, while the handshake is still pending
      one.addRelay(`WS://127.0.0.1:${slow.port}`); // and a different spelling of it
      await starting;
      await wait(100);
      expect(slow.connections).toBe(1);
      expect(slow.subscriptionCount).toBe(1);
    });

    it("a relay released or stopped while it is still connecting opens no REQ once it connects", async () => {
      // An injected pool: the server does not close its sockets, so the connect completes
      // after the server lost interest and the guard after ensureRelay is what stops the REQ.
      const slow = await TestRelay.start(0, { acceptDelayMs: 300 });
      cleanups.push(() => slow.close());
      const pool = new SimplePool();
      cleanups.push(() => pool.close([slow.url, relay.url]));

      const stopped = new BunkerServer({ connectionSecretKey: generateSecretKey(), relays: [slow.url], pool, handler: signerHandler(user) });
      const starting = stopped.start();
      await wait(50);
      await stopped.stop();
      await starting;
      await wait(500);
      expect(slow.connections).toBe(1); // the pool kept its socket
      expect(slow.subscriptionCount).toBe(0); // but nothing subscribed on it

      const releasing = new BunkerServer({ connectionSecretKey: generateSecretKey(), relays: [relay.url], pool, handler: signerHandler(user) });
      await releasing.start();
      cleanups.push(() => releasing.stop());
      const clientPubkey = getPublicKey(generateSecretKey());
      const uri = `nostrconnect://${clientPubkey}?relay=${encodeURIComponent(slow.url)}&secret=slow-scan`;
      const accepting = releasing.acceptNostrConnect(uri).catch(() => null);
      await wait(50); // the handler has approved; #admit is waiting on the slow relay
      releasing.disconnectClient(clientPubkey);
      await accepting;
      await wait(500);
      expect(releasing.listeningRelays).toEqual([relay.url]);
      expect(slow.subscriptionCount).toBe(0);
    });
  });

  describe("persistence across restarts", () => {
    /** The app's restart: same connection key, a fresh process, whatever the host persisted handed back. */
    async function restart(previous: BunkerServer, state: BunkerState, handler = signerHandler(user)): Promise<BunkerServer> {
      await previous.stop();
      const next = new BunkerServer({ connectionSecretKey: connectionSk, relays: [relay.url], handler });
      await next.restore(state);
      await next.start();
      cleanups.push(() => next.stop());
      return next;
    }

    it("a restored secret keeps its binding: after a restart a different client presenting it is refused", async () => {
      const { uri, secret } = server.createBunkerUri();
      const a = await connectWithNostrTools(uri);
      expect(await a.getPublicKey()).toBe(userPubkey);
      const state = server.exportState();
      expect(state.secrets).toEqual([
        { secret, origin: "bunker", relays: [relay.url], clientPubkey: expect.any(String), confirmed: true },
      ]);

      const next = await restart(server, state);
      next.createBunkerUri({ secret }); // the app re-mints the stored secret for display; that must not unbind it
      const bp = (await parseBunkerInput(uri))!;
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));
      const intruder = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await expect(intruder.connect()).rejects.toBe("secret already used by another client");
      await intruder.close();
      expect(next.connectedClients).toEqual([state.clients[0]!.clientPubkey]);
    });

    it("restored clients keep working after a restart without re-pairing, on their own relays", async () => {
      const clientRelay = await TestRelay.start();
      cleanups.push(() => clientRelay.close());
      const aSk = generateSecretKey();
      const aPubkey = getPublicKey(aSk);
      const aPool = new SimplePool();
      const uri = `nostrconnect://${aPubkey}?relay=${encodeURIComponent(clientRelay.url)}&secret=persist-me`;
      const abort = new AbortController();
      const ready = BunkerSigner.fromURI(aSk, uri, { pool: aPool }, abort.signal);
      cleanups.push(async () => {
        abort.abort();
        await ready.then((s) => s.close()).catch(() => {});
        aPool.close([clientRelay.url]);
      });
      await clientRelay.waitForSubscriber(aPubkey);
      await server.acceptNostrConnect(uri);
      const a = await ready;
      expect(await a.getPublicKey()).toBe(userPubkey);

      const state = server.exportState();
      expect(state.clients).toEqual([{ clientPubkey: aPubkey, relays: [clientRelay.url], secret: "persist-me", connectedAt: expect.any(Number) }]);
      expect(state.secrets).toEqual([{ secret: "persist-me", origin: "nostrconnect", relays: [clientRelay.url], clientPubkey: aPubkey, confirmed: true }]);

      const next = await restart(server, state);
      expect(next.connectedClients).toEqual([aPubkey]);
      expect(next.relaysFor(aPubkey)).toEqual([clientRelay.url]);
      expect(next.listeningRelays.sort()).toEqual([relay.url, clientRelay.url].sort());
      // No connect, no re-pair: the client just carries on, and is answered on its own relay.
      const signed = await a.signEvent({ kind: 1, content: "after restart", tags: [], created_at: 1 });
      expect(signed.pubkey).toBe(userPubkey);
      expect(relay.received.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === aPubkey))).toEqual([]);
      expect(next.exportState()).toEqual(state);
    });

    it("onStateChange fires on every change and what it hands out restores cleanly", async () => {
      const snapshots: BunkerState[] = [];
      const watched = new BunkerServer({
        connectionSecretKey: generateSecretKey(),
        relays: [relay.url],
        handler: signerHandler(user),
        onStateChange: (state) => snapshots.push(state),
      });
      await watched.start();
      cleanups.push(() => watched.stop());
      const { uri, secret } = watched.createBunkerUri();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.secrets[0]).toMatchObject({ secret, confirmed: false });
      const a = await connectWithNostrTools(uri);
      const last = snapshots[snapshots.length - 1]!;
      expect(last.clients).toHaveLength(1);
      expect(last.secrets[0]).toMatchObject({ secret, confirmed: true, clientPubkey: last.clients[0]!.clientPubkey });
      await a.logout();
      expect(snapshots[snapshots.length - 1]!.clients).toEqual([]);
      expect(snapshots[snapshots.length - 1]!.secrets[0]).toMatchObject({ secret, confirmed: true }); // the binding outlives the session
      const n = snapshots.length;
      expect(watched.revokeSecret(secret)).toBe(true);
      expect(snapshots).toHaveLength(n + 1);
      expect(snapshots[n]!.secrets).toEqual([]);
    });

    it("a revoked secret is refused, an unclaimed secret lapses at its TTL, a confirmed binding never does", async () => {
      const { uri, secret } = server.createBunkerUri();
      expect(server.revokeSecret(secret)).toBe(true);
      expect(server.revokeSecret(secret)).toBe(false);
      const bp = (await parseBunkerInput(uri))!;
      const pool = new SimplePool();
      cleanups.push(() => pool.close([relay.url]));
      const late = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
      await expect(late.connect()).rejects.toBe("invalid secret");
      await late.close();

      const shortLived = server.createBunkerUri({ ttlMs: 150 });
      expect(server.exportState().secrets.find((r) => r.secret === shortLived.secret)?.expiresAt).toEqual(expect.any(Number));
      await wait(200);
      const tooLate = BunkerSigner.fromBunker(generateSecretKey(), (await parseBunkerInput(shortLived.uri))!, { pool });
      await expect(tooLate.connect()).rejects.toBe("invalid secret");
      await tooLate.close();
      expect(server.exportState().secrets.find((r) => r.secret === shortLived.secret)).toBeUndefined(); // swept

      const claimed = server.createBunkerUri({ ttlMs: 150 });
      const clientSk = generateSecretKey();
      const first = BunkerSigner.fromBunker(clientSk, (await parseBunkerInput(claimed.uri))!, { pool });
      await first.connect();
      await first.close();
      await wait(200);
      const again = BunkerSigner.fromBunker(clientSk, (await parseBunkerInput(claimed.uri))!, { pool });
      await again.connect(); // confirmed: the TTL no longer applies
      expect(await again.getPublicKey()).toBe(userPubkey);
      await again.close();
      expect(server.exportState().secrets.find((r) => r.secret === claimed.secret)).toMatchObject({ confirmed: true });
    });

    it("the server-level secretTtlMs applies to every mint, and 0 disables it", async () => {
      const ttl = new BunkerServer({ connectionSecretKey: generateSecretKey(), relays: [relay.url], secretTtlMs: 100, handler: signerHandler(user) });
      await ttl.start();
      cleanups.push(() => ttl.stop());
      const minted = ttl.createBunkerUri();
      await wait(150);
      ttl.createBunkerUri(); // any mint sweeps lapsed, unclaimed secrets
      expect(ttl.exportState().secrets.map((r) => r.secret)).not.toContain(minted.secret);

      const forever = new BunkerServer({ connectionSecretKey: generateSecretKey(), relays: [relay.url], secretTtlMs: 0, handler: signerHandler(user) });
      await forever.start();
      cleanups.push(() => forever.stop());
      const kept = forever.createBunkerUri();
      expect(forever.exportState().secrets[0]).toEqual({ secret: kept.secret, origin: "bunker", relays: [relay.url], confirmed: false });
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
