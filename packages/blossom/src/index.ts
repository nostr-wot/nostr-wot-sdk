import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { NostrSigner } from "@nostr-wot/signers";
import { buildAuthHeader, checkpoint, settle, validateDescriptor, serverUrl } from "./upload.js";

/** Blossom BUD-11 authorization event kind. */
export const KIND_BLOSSOM_AUTH = 24242;
export const DEFAULT_BLOSSOM_SERVERS = [
  "https://blossom.primal.net",
  "https://nostr.build",
  "https://blossom.band",
];

export type BlossomBlob = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
};
export type BlossomSigner = Pick<NostrSigner, "signEvent">;
export type BlossomUploadLifecycle = {
  signal?: AbortSignal;
  /** Throws when the caller's session or operation is no longer current. */
  assertActive?: () => void;
};
export type BlossomUploadOptions = BlossomUploadLifecycle & {
  signer: BlossomSigner;
  servers?: readonly string[];
  /** Positive, finite auth lifetime in seconds. Defaults to one hour. */
  authExpirySec?: number;
  /** Empty or missing MIME types default to application/octet-stream. */
  contentType?: string;
  /** Sign separately for each server hostname. Defaults to false (one signature). */
  bindAuthToServer?: boolean;
};

/** All attempted servers failed. Reasons are diagnostics, not suitable for UI copy. */
export class BlossomUploadError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Blossom upload failed: ${reasons.length ? reasons.join("; ") : "no server to try"}`);
    this.name = "BlossomUploadError";
    this.reasons = Object.freeze([...reasons]);
  }
}

type UploadInput = File | Blob | ArrayBuffer | Uint8Array;

/** Upload immutable bytes to the first server returning a valid BUD-02 descriptor. */
export async function uploadToBlossom(file: UploadInput, options: BlossomUploadOptions): Promise<BlossomBlob> {
  return upload(file, options, false);
}

/** Upload ciphertext under a fresh disposable identity, with server-scoped authorization. */
export async function uploadEncryptedBlob(
  ciphertext: Uint8Array,
  options: BlossomUploadLifecycle & { servers: readonly string[] },
): Promise<BlossomBlob> {
  checkpoint(options);
  const key = generateSecretKey();
  try {
    return await upload(ciphertext, {
      ...options,
      signer: { signEvent: async (template) => finalizeEvent(template, key) },
      contentType: "application/octet-stream",
      bindAuthToServer: true,
    }, true);
  } finally {
    key.fill(0);
  }
}

async function upload(file: UploadInput, options: BlossomUploadOptions, requireHttps: boolean): Promise<BlossomBlob> {
  checkpoint(options);
  const servers = [...(options.servers ?? DEFAULT_BLOSSOM_SERVERS)];
  if (!servers.length) throw new BlossomUploadError([]);
  const expiry = options.authExpirySec ?? 3600;
  if (!Number.isFinite(expiry) || expiry < 1 || !Number.isSafeInteger(Math.floor(Date.now() / 1000) + Math.floor(expiry))) {
    throw new RangeError("Auth expiry must be a positive finite number of seconds");
  }
  // Snapshot before the first await: caller mutation must not change the signed body.
  const bytes = file instanceof Uint8Array ? new Uint8Array(file)
    : file instanceof ArrayBuffer ? new Uint8Array(file.slice(0))
    : new Uint8Array(await file.arrayBuffer());
  checkpoint(options);
  const hash = bytesToHex(sha256(bytes));
  const contentType = (options.contentType ?? (typeof Blob !== "undefined" && file instanceof Blob ? file.type : "")).trim() || "application/octet-stream";
  let sharedAuth: string | undefined;
  const reasons: string[] = [];
  for (const base of servers) {
    checkpoint(options);
    let server: URL;
    try { server = serverUrl(base, requireHttps); }
    catch (error) { reasons.push(`${base}: ${String(error)}`); continue; }
    // Signing failures are caller failures, never an invitation to prompt again on another host.
    const auth = sharedAuth ?? await buildAuthHeader(options.signer, "upload", hash, expiry, options, options.bindAuthToServer ? server : undefined);
    if (!options.bindAuthToServer) sharedAuth = auth;
    const response = await settle(() => fetch(`${server.href.replace(/\/$/, "")}/upload`, {
      method: "PUT",
      // Never forward bytes or authorization beyond the explicitly selected server.
      redirect: "error",
      headers: { Authorization: auth, "Content-Type": contentType, "X-SHA-256": hash },
      body: bytes as unknown as BodyInit,
      signal: options.signal,
    }), options);
    if (!response.ok) { reasons.push(`${base}: ${String(response.error)}`); continue; }
    if (!response.value.ok) {
      const detail = await settle(() => response.value.text(), options);
      reasons.push(`${base}: ${response.value.status} ${detail.ok ? detail.value.slice(0, 120) : response.value.statusText}`);
      continue;
    }
    const data = await settle(() => response.value.json(), options);
    if (!data.ok) { reasons.push(`${base}: not a Blossom JSON response`); continue; }
    try { return validateDescriptor(data.value, hash, bytes.length, requireHttps); }
    catch (error) { reasons.push(`${base}: ${String(error)}`); }
  }
  checkpoint(options);
  throw new BlossomUploadError(reasons);
}

/** Download a blob and return descriptors for its successful mirrors. */
export async function mirrorBlob(
  url: string,
  options: { signer: BlossomSigner; targetServers?: readonly string[] },
): Promise<BlossomBlob[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source ${url} returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const results: BlossomBlob[] = [];
  for (const target of options.targetServers ?? DEFAULT_BLOSSOM_SERVERS) {
    try { results.push(await uploadToBlossom(bytes, { signer: options.signer, servers: [target], contentType })); }
    catch { /* A failed mirror does not discard successful mirrors. */ }
  }
  return results;
}

/** Best-effort deletion; servers may retain blobs referenced by other users. */
export async function deleteBlob(hash: string, options: { signer: BlossomSigner; server: string }): Promise<boolean> {
  const server = serverUrl(options.server, false);
  const auth = await buildAuthHeader(options.signer, "delete", hash, 60, {}, server);
  const res = await fetch(`${server.href.replace(/\/$/, "")}/${hash}`, {
    method: "DELETE", headers: { Authorization: auth },
  });
  return res.ok;
}
