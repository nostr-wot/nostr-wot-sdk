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

// ────────────────────────────────────────────────────────────────────
// Reverse direction — wrap a NostrSigner so it satisfies NDKSigner.
// Useful when migrating an NDK-based app onto @nostr-wot/* gradually:
// log in via @nostr-wot/ui, then hand the resulting signer back to the
// existing NDK call sites without rewriting them.
// ────────────────────────────────────────────────────────────────────

/** Minimal NDKUser shape. Real NDKUser instances satisfy this. */
export interface NdkUserLike {
  pubkey: string;
}

/** Minimal NDKSigner shape we produce. Compatible with NDK ≥ 2.x. */
export interface NdkSignerOut {
  readonly pubkey: string;
  readonly userSync: NdkUserLike;
  user(): Promise<NdkUserLike>;
  blockUntilReady(): Promise<NdkUserLike>;
  sign(event: {
    kind?: number;
    created_at?: number;
    tags?: string[][];
    content: string;
  }): Promise<string>;
  encrypt(
    recipient: NdkUserLike,
    value: string,
    scheme?: "nip04" | "nip44",
  ): Promise<string>;
  decrypt(
    sender: NdkUserLike,
    value: string,
    scheme?: "nip04" | "nip44",
  ): Promise<string>;
  encryptionEnabled(scheme?: "nip04" | "nip44"): Promise<("nip04" | "nip44")[]>;
  toPayload(): string;
}

export interface NostrAsNdkOptions {
  /**
   * Optional `NDKUser` constructor. When supplied, `user()` and
   * `userSync` return real NDKUser instances; otherwise they return
   * a plain `{ pubkey }` object that satisfies the NDKUser shape used
   * by every standard NDK code path.
   */
  NDKUser?: new (init: { pubkey: string }) => NdkUserLike;
}

/**
 * Wrap a `NostrSigner` so it satisfies NDK's `NDKSigner` interface.
 * The pubkey is resolved synchronously up front, so the resulting
 * signer can be used immediately by NDK code paths that depend on the
 * sync `pubkey` getter.
 *
 * Encryption/decryption methods on the wrapped signer are conditionally
 * available — if the underlying `NostrSigner` doesn't implement
 * `nip04Encrypt`, calling `encrypt(..., 'nip04')` on the wrapper throws.
 *
 * `toPayload()` returns a sentinel string; consumers that round-trip
 * NDK signers via `toPayload`/`ndkSignerFromPayload` should persist
 * via the SDK's `SignerStorage` instead.
 */
export async function nostrSignerAsNdkSigner(
  signer: NostrSigner,
  opts: NostrAsNdkOptions = {},
): Promise<NdkSignerOut> {
  const pubkey = await signer.getPublicKey();
  const user: NdkUserLike = opts.NDKUser ? new opts.NDKUser({ pubkey }) : { pubkey };
  const wrapper: NdkSignerOut = {
    get pubkey() {
      return pubkey;
    },
    get userSync() {
      return user;
    },
    async user() {
      return user;
    },
    async blockUntilReady() {
      return user;
    },
    async sign(event): Promise<string> {
      if (typeof event.kind !== "number") {
        throw new Error("nostrSignerAsNdkSigner: event is missing `kind`");
      }
      const signed = await signer.signEvent({
        kind: event.kind,
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
        tags: event.tags ?? [],
        content: event.content,
      });
      return signed.sig;
    },
    async encrypt(recipient, value, scheme) {
      if (scheme === "nip44") {
        if (!signer.nip44Encrypt) {
          throw new Error("signer does not support NIP-44 encryption");
        }
        return signer.nip44Encrypt(recipient.pubkey, value);
      }
      if (!signer.nip04Encrypt) {
        throw new Error("signer does not support NIP-04 encryption");
      }
      return signer.nip04Encrypt(recipient.pubkey, value);
    },
    async decrypt(sender, value, scheme) {
      if (scheme === "nip44") {
        if (!signer.nip44Decrypt) {
          throw new Error("signer does not support NIP-44 decryption");
        }
        return signer.nip44Decrypt(sender.pubkey, value);
      }
      if (!signer.nip04Decrypt) {
        throw new Error("signer does not support NIP-04 decryption");
      }
      return signer.nip04Decrypt(sender.pubkey, value);
    },
    async encryptionEnabled(scheme) {
      const out: ("nip04" | "nip44")[] = [];
      if (signer.nip04Encrypt) out.push("nip04");
      if (signer.nip44Encrypt) out.push("nip44");
      if (scheme) return out.includes(scheme) ? [scheme] : [];
      return out;
    },
    toPayload() {
      return JSON.stringify({ type: "nostr-as-ndk", pubkey });
    },
  };
  return wrapper;
}
