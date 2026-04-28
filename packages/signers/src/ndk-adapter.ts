/**
 * NDK ↔ NostrSigner adapter.
 *
 * NDK (`@nostr-dev-kit/ndk`) ships its own `NDKSigner` interface. This
 * adapter wraps any `NDKSigner` so it satisfies the SDK's `NostrSigner`
 * contract — letting NDK-using apps adopt `@nostr-wot/*` packages
 * without rewriting their auth layer.
 *
 * `NDKSigner` is typed loosely (`unknown`-ish) here so this module
 * doesn't pull NDK in as a dependency. The caller passes a real NDK
 * instance + signer at construction time.
 */

import type { Event as NostrEvent, EventTemplate } from "nostr-tools";
import type { NostrSigner } from "./types";

/** Minimal subset of NDK we need. Compatible with NDK v2.x. */
export interface NdkLike {
  signer: NdkSignerLike | undefined;
}

export interface NdkSignerLike {
  user(): Promise<{ pubkey: string }>;
  encrypt?(
    user: { pubkey: string },
    plaintext: string,
    scheme?: "nip04" | "nip44",
  ): Promise<string>;
  decrypt?(
    user: { pubkey: string },
    ciphertext: string,
    scheme?: "nip04" | "nip44",
  ): Promise<string>;
}

/**
 * NDK event class shape. Keep it minimal; the adapter only needs to
 * construct, populate, sign, and serialize.
 */
export interface NdkEventCtor {
  new (ndk: NdkLike): NdkEventLike;
}

export interface NdkEventLike {
  kind?: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
  sign(signer?: NdkSignerLike): Promise<string>;
  rawEvent(): NostrEvent;
}

export interface NdkAdapterOptions {
  /** The NDK instance (must have a `signer` set). */
  ndk: NdkLike;
  /** Optional explicit signer override; defaults to `ndk.signer`. */
  signer?: NdkSignerLike;
  /** The NDK `NDKEvent` constructor — pass `NDKEvent` from your
   *  `@nostr-dev-kit/ndk` import. Avoids us depending on NDK directly. */
  NDKEvent: NdkEventCtor;
}

/**
 * Wrap an NDK signer so it satisfies `NostrSigner`. The returned object
 * delegates `signEvent` through `NDKEvent` (so signed events come back
 * with NDK's verification + caching pipeline applied) and proxies
 * encrypt/decrypt through `NDKSigner.encrypt/decrypt`.
 *
 * NDK ≥ 2.10 takes a third argument `scheme` on encrypt/decrypt for
 * NIP-44 support; older versions only support NIP-04 and ignore the
 * extra argument. This adapter targets the modern API and falls back
 * gracefully when a method is missing.
 */
export function ndkSignerAsNostrSigner(
  opts: NdkAdapterOptions,
): NostrSigner {
  const { ndk, NDKEvent } = opts;
  const ndkSigner = opts.signer ?? ndk.signer;
  if (!ndkSigner) {
    throw new Error("ndkSignerAsNostrSigner: NDK has no signer attached");
  }
  return {
    async getPublicKey() {
      const user = await ndkSigner.user();
      return user.pubkey;
    },
    async signEvent(template: EventTemplate): Promise<NostrEvent> {
      const ev = new NDKEvent(ndk);
      ev.kind = template.kind;
      ev.content = template.content;
      ev.tags = template.tags;
      ev.created_at = template.created_at;
      await ev.sign(ndkSigner);
      return ev.rawEvent() as NostrEvent;
    },
    ...(ndkSigner.encrypt
      ? {
          async nip04Encrypt(pubkey: string, plaintext: string) {
            return ndkSigner.encrypt!({ pubkey }, plaintext, "nip04");
          },
          async nip44Encrypt(pubkey: string, plaintext: string) {
            return ndkSigner.encrypt!({ pubkey }, plaintext, "nip44");
          },
        }
      : {}),
    ...(ndkSigner.decrypt
      ? {
          async nip04Decrypt(pubkey: string, ciphertext: string) {
            return ndkSigner.decrypt!({ pubkey }, ciphertext, "nip04");
          },
          async nip44Decrypt(pubkey: string, ciphertext: string) {
            return ndkSigner.decrypt!({ pubkey }, ciphertext, "nip44");
          },
        }
      : {}),
  };
}
