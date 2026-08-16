import { describe, it, expect, afterEach } from "vitest";
import { Nip07Signer } from "../src/index.js";

/**
 * Sets up a fake `window.nostr` with a `nip44.encrypt` that records how many
 * arguments it was called with, so we can assert `Nip07Signer` forwards `opts`
 * only when present — extensions that predate post-quantum support must see the
 * exact two-argument call they have always seen.
 */
function installFakeExtension() {
  const calls: unknown[][] = [];
  (globalThis as { window?: unknown }).window = {
    nostr: {
      async getPublicKey() {
        return "a".repeat(64);
      },
      async signEvent(t: unknown) {
        return t;
      },
      nip44: {
        async encrypt(...args: unknown[]) {
          calls.push(args);
          return "ciphertext";
        },
        async decrypt() {
          return "plaintext";
        },
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("Nip07Signer — post-quantum opts forwarding", () => {
  it("calls the extension with exactly two arguments when no opts are given", async () => {
    const calls = installFakeExtension();
    const signer = new Nip07Signer();

    await signer.nip44Encrypt("b".repeat(64), "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["b".repeat(64), "hello"]);
  });

  it("forwards opts as a third argument when post-quantum sealing is requested", async () => {
    const calls = installFakeExtension();
    const signer = new Nip07Signer();
    const opts = { scheme: "pq" as const, recipientKemKey: "a-base64-kem-key" };

    await signer.nip44Encrypt("b".repeat(64), "hello", opts);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["b".repeat(64), "hello", opts]);
  });
});
