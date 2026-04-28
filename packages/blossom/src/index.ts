import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { NostrSigner } from "@nostr-wot/signers";

/**
 * Blossom — content-addressed file hosting for Nostr.
 * Spec: https://github.com/hzrd149/blossom
 *
 * The kind-24242 BUD-01 auth event proves the upload to the server.
 * Servers verify the signature and that `x` tag matches sha256 of the
 * uploaded body.
 */

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

async function buildAuthHeader(
  signer: NostrSigner,
  action: "upload" | "delete" | "get",
  hash: string,
  expirationSec: number,
): Promise<string> {
  const template = {
    kind: KIND_BLOSSOM_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", action],
      ["x", hash],
      ["expiration", String(Math.floor(Date.now() / 1000) + expirationSec)],
    ],
    content: "",
  };
  const event = await signer.signEvent(template);
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function fileToBytes(file: File | Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (file instanceof Uint8Array) return file;
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Upload a file to the first reachable Blossom server. Returns the
 * resulting blob descriptor (url, sha256, size, type, uploaded).
 *
 * Failover: tries each server in order; if one returns a non-2xx
 * response, moves to the next. Throws if all servers fail.
 */
export async function uploadToBlossom(
  file: File | Blob | ArrayBuffer | Uint8Array,
  options: {
    signer: NostrSigner;
    /** Server list to try in order. Defaults to `DEFAULT_BLOSSOM_SERVERS`. */
    servers?: string[];
    /** Auth event expiration (seconds from now). Default 3600 (1h). */
    authExpirySec?: number;
    /** MIME type — required for `Uint8Array` / `ArrayBuffer` inputs. */
    contentType?: string;
  },
): Promise<BlossomBlob> {
  const bytes = await fileToBytes(file);
  const hash = bytesToHex(sha256(bytes));
  const auth = await buildAuthHeader(
    options.signer,
    "upload",
    hash,
    options.authExpirySec ?? 3600,
  );
  const contentType =
    options.contentType ??
    (typeof File !== "undefined" && file instanceof File ? file.type : undefined) ??
    (typeof Blob !== "undefined" && file instanceof Blob ? file.type : undefined) ??
    "application/octet-stream";
  const servers = options.servers ?? DEFAULT_BLOSSOM_SERVERS;

  let lastError: Error | null = null;
  for (const base of servers) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/upload`, {
        method: "PUT",
        headers: {
          Authorization: auth,
          "Content-Type": contentType,
        },
        body: bytes as unknown as BodyInit,
      });
      if (!res.ok) {
        lastError = new Error(`${base} returned ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      const blob = (await res.json()) as BlossomBlob;
      return blob;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("All Blossom servers failed");
}

/**
 * Mirror an existing blob to a fallback server. Useful for backing up
 * before relying on a single host.
 */
export async function mirrorBlob(
  url: string,
  options: { signer: NostrSigner; targetServers?: string[] },
): Promise<BlossomBlob[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source ${url} returned ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const targets = options.targetServers ?? DEFAULT_BLOSSOM_SERVERS;
  const results: BlossomBlob[] = [];
  for (const target of targets) {
    try {
      const blob = await uploadToBlossom(bytes, {
        signer: options.signer,
        servers: [target],
        contentType,
      });
      results.push(blob);
    } catch {
      /* one mirror failure shouldn't kill the others */
    }
  }
  return results;
}

/**
 * Delete a previously uploaded blob (server may or may not honor it).
 */
export async function deleteBlob(
  hash: string,
  options: { signer: NostrSigner; server: string },
): Promise<boolean> {
  const auth = await buildAuthHeader(options.signer, "delete", hash, 60);
  const res = await fetch(`${options.server.replace(/\/$/, "")}/${hash}`, {
    method: "DELETE",
    headers: { Authorization: auth },
  });
  return res.ok;
}
