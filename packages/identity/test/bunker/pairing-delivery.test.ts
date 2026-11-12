import { expect, it, vi } from "vitest";
import { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BunkerServer } from "../../src/bunker";

it("reports failed acknowledgement delivery and allows the approved client to retry", async () => {
  const pool = new SimplePool();
  const publish = vi.spyOn(pool, "publish")
    .mockImplementationOnce(() => [Promise.reject(new Error("offline"))])
    .mockImplementationOnce(() => [Promise.resolve("accepted")]);
  const server = new BunkerServer({
    connectionSecretKey: generateSecretKey(), relays: ["wss://host.example"],
    pool, handler: async () => "ack",
  });
  const client = getPublicKey(generateSecretKey());
  const uri = `nostrconnect://${client}?relay=wss%3A%2F%2Fclient.example&secret=pairing-test`;
  try {
    await expect(server.acceptNostrConnect(uri)).rejects.toThrow("No relay acknowledged");
    await expect(server.acceptNostrConnect(uri)).resolves.toMatchObject({ clientPubkey: client });
    expect(publish).toHaveBeenCalledTimes(2);
  } finally {
    await server.stop();
    publish.mockRestore();
  }
});

it("repeats the ephemeral approval for a returning browser and stops on revocation", async () => {
  vi.useFakeTimers();
  const pool = new SimplePool();
  const publish = vi.spyOn(pool, "publish").mockImplementation(() => [Promise.resolve("accepted")]);
  const server = new BunkerServer({
    connectionSecretKey: generateSecretKey(), relays: ["wss://host.example"], pool, handler: async () => "ack",
  });
  const client = getPublicKey(generateSecretKey());
  try {
    await server.acceptNostrConnect(`nostrconnect://${client}?relay=wss%3A%2F%2Fclient.example&secret=return`);
    await vi.advanceTimersByTimeAsync(1500);
    expect(publish).toHaveBeenCalledTimes(2);
    server.disconnectClient(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
  } finally {
    await server.stop();
    vi.useRealTimers();
    publish.mockRestore();
  }
});
