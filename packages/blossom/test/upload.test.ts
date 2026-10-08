import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { BlossomUploadError, deleteBlob, mirrorBlob, uploadEncryptedBlob, uploadToBlossom } from "../src/index.js";

const bytes = new Uint8Array([1, 2, 3]);
const hash = bytesToHex(sha256(bytes));
const servers = ["https://ONE.example:8443", "https://two.example"] as const;
const descriptor = (overrides: Record<string, unknown> = {}) => ({ url: `https://cdn.example/${hash}.bin`, sha256: hash, size: 3, type: "application/octet-stream", uploaded: 123, ...overrides });
function signer() {
  const key = generateSecretKey();
  return { signEvent: vi.fn(async (template) => finalizeEvent(template, key)) };
}
function auth(init: RequestInit) {
  const header = (init.headers as Record<string, string>).Authorization;
  expect(header).toMatch(/^Nostr [A-Za-z0-9_-]+$/);
  return JSON.parse(Buffer.from(header.slice(6), "base64url").toString("utf8"));
}
// Use a real Response so malformed response bodies exercise the browser JSON contract.
function installFetch() { const mock = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", mock); return mock; }
afterEach(() => vi.unstubAllGlobals());

describe("public upload", () => {
  it("uses one signature across HTTP/network failover and returns a verified descriptor", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(new Response("denied", { status: 403 })).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(Response.json(descriptor()));
    const identity = signer();
    await expect(uploadToBlossom(bytes, { signer: identity, servers: [...servers, "https://three.example"] })).resolves.toEqual(descriptor());
    expect(identity.signEvent).toHaveBeenCalledTimes(1);
    const tokens = fetch.mock.calls.map(([, init]) => auth(init!));
    expect(tokens[0]).toEqual(tokens[2]);
    expect(tokens[0].tags).toContainEqual(["x", hash]);
    expect(tokens[0].tags.find((tag: string[]) => tag[0] === "server")).toBeUndefined();
    expect(tokens[0].content).toBe("Upload blob");
    expect(verifyEvent(tokens[0])).toBe(true);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ "X-SHA-256": hash, "Content-Type": "application/octet-stream" });
  });

  it("optionally scopes separate signatures to lowercase hostname without port", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(new Response("bad", { status: 500 })).mockResolvedValueOnce(Response.json(descriptor()));
    const identity = signer();
    await uploadToBlossom(bytes, { signer: identity, servers, bindAuthToServer: true });
    expect(identity.signEvent).toHaveBeenCalledTimes(2);
    expect(auth(fetch.mock.calls[0][1]!).tags).toContainEqual(["server", "one.example"]);
    expect(auth(fetch.mock.calls[1][1]!).tags).toContainEqual(["server", "two.example"]);
  });

  it.each([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]).buffer])("snapshots mutable input before awaiting a signer", async (input) => {
    const fetch = installFetch().mockResolvedValue(Response.json(descriptor()));
    const identity = signer();
    const originalSign = identity.signEvent.getMockImplementation()!;
    identity.signEvent.mockImplementation(async (template) => {
      (input instanceof Uint8Array ? input : new Uint8Array(input)).fill(9);
      return originalSign(template);
    });
    await uploadToBlossom(input, { signer: identity, servers });
    expect([...new Uint8Array(fetch.mock.calls[0][1]!.body as Uint8Array)]).toEqual([1, 2, 3]);
    expect(auth(fetch.mock.calls[0][1]!).tags).toContainEqual(["x", hash]);
  });

  it.each([undefined, "", "   "])("defaults empty MIME %j for a typeless Blob", async (contentType) => {
    const fetch = installFetch().mockResolvedValue(Response.json(descriptor()));
    await uploadToBlossom(new Blob([bytes]), { signer: signer(), servers, contentType });
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ "Content-Type": "application/octet-stream" });
  });

  it("uses Blob MIME and explicit MIME override", async () => {
    const fetch = installFetch().mockImplementation(async () => Response.json(descriptor({ type: "image/png" })));
    await uploadToBlossom(new Blob([bytes], { type: "image/png" }), { signer: signer(), servers });
    await uploadToBlossom(bytes, { signer: signer(), servers, contentType: "text/plain" });
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ "Content-Type": "image/png" });
    expect(fetch.mock.calls[1][1]!.headers).toMatchObject({ "Content-Type": "text/plain" });
  });

  it.each([NaN, Infinity, -1, 0, Number.MAX_VALUE])("rejects invalid auth expiry %s", async (authExpirySec) => {
    const fetch = installFetch();
    await expect(uploadToBlossom(bytes, { signer: signer(), servers, authExpirySec })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not prompt or fetch with an empty server list", async () => {
    const fetch = installFetch(); const identity = signer();
    await expect(uploadToBlossom(bytes, { signer: identity, servers: [] })).rejects.toMatchObject({ reasons: [] });
    expect(identity.signEvent).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("never retries signer rejection (scoped=%s)", async (bindAuthToServer) => {
    const fetch = installFetch(); const identity = signer(); const rejected = new Error("signer denied");
    identity.signEvent.mockRejectedValue(rejected);
    await expect(uploadToBlossom(bytes, { signer: identity, servers, bindAuthToServer })).rejects.toBe(rejected);
    expect(identity.signEvent).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("descriptor validation", () => {
  it.each([
    null, [], {}, { url: `https://cdn.example/${hash}.bin` },
    descriptor({ sha256: "0".repeat(64) }), descriptor({ size: 4 }), descriptor({ size: "3" }),
    descriptor({ type: "" }), descriptor({ type: 1 }), descriptor({ type: "not a mime" }),
    descriptor({ uploaded: -1 }), descriptor({ uploaded: Infinity }), descriptor({ uploaded: 1.5 }),
    descriptor({ url: `https://cdn.example/${hash}/wrong.bin` }),
    descriptor({ url: `https://cdn.example/prefix${hash}.bin` }),
    descriptor({ url: `https://cdn.example/${hash}suffix.bin` }),
    descriptor({ url: `https://cdn.example/wrong.bin?hash=${hash}` }),
    descriptor({ url: `ftp://cdn.example/${hash}.bin` }),
    descriptor({ url: `https://user:pass@cdn.example/${hash}.bin` }),
  ])("fails over invalid descriptor %#", async (invalid) => {
    const fetch = installFetch().mockResolvedValueOnce(Response.json(invalid)).mockResolvedValueOnce(Response.json(descriptor()));
    await expect(uploadToBlossom(bytes, { signer: signer(), servers })).resolves.toEqual(descriptor());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aggregates invalid JSON, HTTP failures, network failures, and descriptor failures", async () => {
    const fetch = installFetch().mockResolvedValueOnce(new Response("<html>"))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json(descriptor({ sha256: "bad" })));
    const error = await uploadToBlossom(bytes, { signer: signer(), servers: [...servers, "https://three.example", "https://four.example"] }).catch((e) => e);
    expect(error).toBeInstanceOf(BlossomUploadError);
    expect(error.reasons).toHaveLength(4);
    expect(error.message).toContain("not a Blossom JSON response");
    expect(error.message).toContain("403 denied");
    expect(error.message).toContain("offline");
    expect(error.message).toContain("does not match");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("accepts plain HTTP public blobs and a bare hash filename", async () => {
    installFetch().mockResolvedValue(Response.json(descriptor({ url: `http://cdn.example/${hash}` })));
    await expect(uploadToBlossom(bytes, { signer: signer(), servers: ["http://local.example"] })).resolves.toMatchObject({ url: `http://cdn.example/${hash}` });
  });
});

describe("encrypted uploads", () => {
  it.each([false, true])("rejects redirects and tries only explicit fallback servers (encrypted=%s)", async (encrypted) => {
    const fetch = installFetch().mockRejectedValueOnce(new TypeError("fetch failed: redirect"))
      .mockResolvedValueOnce(Response.json(descriptor()));
    const result = encrypted
      ? await uploadEncryptedBlob(bytes, { servers })
      : await uploadToBlossom(bytes, { signer: signer(), servers });
    expect(result).toEqual(descriptor());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://one.example:8443/upload", "https://two.example/upload"]);
    fetch.mock.calls.forEach(([, init]) => expect(init!.redirect).toBe("error"));
  });

  it("uses a fresh identity per upload and one identity across server-scoped retries", async () => {
    const fetch = installFetch().mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockImplementation(async () => Response.json(descriptor()));
    await uploadEncryptedBlob(bytes, { servers });
    await uploadEncryptedBlob(bytes, { servers });
    const tokens = fetch.mock.calls.map(([, init]) => auth(init!));
    expect(tokens[0].pubkey).toBe(tokens[1].pubkey);
    expect(tokens[0].pubkey).not.toBe(tokens[2].pubkey);
    tokens.forEach((token) => expect(verifyEvent(token)).toBe(true));
    expect(tokens[0].tags).toContainEqual(["server", "one.example"]);
    expect(tokens[1].tags).toContainEqual(["server", "two.example"]);
    fetch.mock.calls.forEach(([, init]) => expect(init!.headers).toMatchObject({ "Content-Type": "application/octet-stream" }));
  });

  it("refuses HTTP destinations and HTTP descriptors for encrypted uploads", async () => {
    const fetch = installFetch().mockResolvedValue(Response.json(descriptor({ url: `http://cdn.example/${hash}` })));
    await expect(uploadEncryptedBlob(bytes, { servers: ["http://insecure.example", ...servers] })).rejects.toMatchObject({ reasons: expect.any(Array) });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mock.calls.forEach(([url]) => expect(String(url)).toMatch(/^https:/));
  });
});

describe("lifecycle boundaries", () => {
  it("stops before reading bytes or prompting if already inactive", async () => {
    const fetch = installFetch(); const identity = signer(); const inactive = new Error("changed");
    const file = new Blob([bytes]); const read = vi.spyOn(file, "arrayBuffer");
    await expect(uploadToBlossom(file, { signer: identity, servers, assertActive: () => { throw inactive; } })).rejects.toBe(inactive);
    expect(read).not.toHaveBeenCalled(); expect(identity.signEvent).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["read", "sign", "fetch", "json", "error-text"])("stops after awaited %s without swallowing a one-shot lifecycle failure", async (stage) => {
    const fetch = installFetch(); const identity = signer(); const inactive = new Error("changed");
    let active = true; let thrown = false;
    const assertActive = () => { if (!active && !thrown) { thrown = true; throw inactive; } };
    const file = new Blob([bytes]);
    if (stage === "read") vi.spyOn(file, "arrayBuffer").mockImplementation(async () => { active = false; return bytes.slice().buffer; });
    if (stage === "sign") { const original = identity.signEvent.getMockImplementation()!; identity.signEvent.mockImplementation(async (template) => { active = false; return original(template); }); }
    fetch.mockImplementation(async () => {
      if (stage === "fetch") active = false;
      const response = Response.json(descriptor(), { status: stage === "error-text" ? 403 : 200 });
      if (stage === "json") vi.spyOn(response, "json").mockImplementation(async () => { active = false; return descriptor(); });
      if (stage === "error-text") vi.spyOn(response, "text").mockImplementation(async () => { active = false; return "denied"; });
      return response;
    });
    await expect(uploadToBlossom(file, { signer: identity, servers, assertActive })).rejects.toBe(inactive);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("forwards signal and does not retry an aborted fetch", async () => {
    const controller = new AbortController(); const abort = new Error("cancelled");
    const fetch = installFetch().mockImplementation(async () => { controller.abort(abort); throw new Error("network"); });
    await expect(uploadToBlossom(bytes, { signer: signer(), servers, signal: controller.signal })).rejects.toBe(abort);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]!.signal).toBe(controller.signal);
  });

  it("propagates AbortError even if no signal was supplied", async () => {
    const abort = new DOMException("aborted", "AbortError"); const fetch = installFetch().mockRejectedValue(abort);
    await expect(uploadEncryptedBlob(bytes, { servers })).rejects.toBe(abort);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not sign on a pre-aborted signal", async () => {
    const controller = new AbortController(); controller.abort(); const identity = signer();
    await expect(uploadToBlossom(bytes, { signer: identity, servers, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(identity.signEvent).not.toHaveBeenCalled();
  });
});

it("mirrors to the successful targets and uses the documented delete API", async () => {
  const fetch = installFetch().mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/png" } }))
    .mockResolvedValueOnce(new Response("denied", { status: 403 })).mockResolvedValueOnce(Response.json(descriptor()))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const identity = signer();
  await expect(mirrorBlob(`https://source.example/${hash}`, { signer: identity, targetServers: servers })).resolves.toEqual([descriptor()]);
  await expect(deleteBlob(hash, { signer: identity, server: servers[0] })).resolves.toBe(true);
  const deletion = fetch.mock.calls[3][1]!;
  expect(deletion.method).toBe("DELETE");
  expect(auth(deletion).tags).toContainEqual(["t", "delete"]);
  expect(auth(deletion).tags).toContainEqual(["server", "one.example"]);
});
