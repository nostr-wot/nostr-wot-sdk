import type { BlossomBlob, BlossomSigner, BlossomUploadLifecycle } from "./index.js";

/** Keep lifecycle exceptions outside server-failure catch blocks. */
export function checkpoint(options: BlossomUploadLifecycle): void {
  options.signal?.throwIfAborted();
  options.assertActive?.();
}

export async function settle<T>(operation: () => Promise<T>, options: BlossomUploadLifecycle): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  checkpoint(options);
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try { result = { ok: true, value: await operation() }; }
  catch (error) { result = { ok: false, error }; }
  checkpoint(options);
  if (!result.ok && typeof result.error === "object" && result.error !== null && "name" in result.error && result.error.name === "AbortError") throw result.error;
  return result;
}

export async function buildAuthHeader(
  signer: BlossomSigner,
  action: "upload" | "delete",
  hash: string,
  expirationSec: number,
  lifecycle: BlossomUploadLifecycle,
  server?: URL,
): Promise<string> {
  checkpoint(lifecycle);
  const now = Math.floor(Date.now() / 1000);
  const tags = [["t", action], ["x", hash], ["expiration", String(now + Math.floor(expirationSec))]];
  if (server) tags.push(["server", server.hostname.toLowerCase()]);
  const event = await signer.signEvent({ kind: 24242, created_at: now, tags, content: action === "upload" ? "Upload blob" : "Delete blob" });
  checkpoint(lifecycle);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of jsonBytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export function serverUrl(value: string, requireHttps: boolean): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && (requireHttps || url.protocol !== "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Blossom server URL");
  }
  return url;
}

export function validateDescriptor(value: unknown, hash: string, size: number, requireHttps: boolean): BlossomBlob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Blossom descriptor");
  const data = value as Record<string, unknown>;
  if (typeof data.url !== "string") throw new Error("Missing Blossom URL");
  const url = new URL(data.url);
  if ((url.protocol !== "https:" && (requireHttps || url.protocol !== "http:")) || url.username || url.password) throw new Error("Invalid Blossom URL");
  const filename = url.pathname.split("/").pop() ?? "";
  if (!new RegExp(`^${hash}(?:\\.[a-zA-Z0-9_-]+)?$`).test(filename)) throw new Error("Response URL does not name the uploaded blob");
  if (data.sha256 !== hash || data.size !== size) throw new Error("Blob hash or size does not match upload");
  if (typeof data.type !== "string" || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(data.type)) throw new Error("Invalid blob MIME type");
  if (typeof data.uploaded !== "number" || !Number.isSafeInteger(data.uploaded) || data.uploaded < 0) throw new Error("Invalid upload timestamp");
  return { url: data.url, sha256: hash, size, type: data.type, uploaded: data.uploaded };
}
