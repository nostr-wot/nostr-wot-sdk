# @nostr-wot/blossom

[Blossom](https://github.com/hzrd149/blossom) content-addressed uploads, mirrors, and deletion, with signed [BUD-11 authorization](https://github.com/hzrd149/blossom/blob/master/buds/11.md) and validated [BUD-02 descriptors](https://github.com/hzrd149/blossom/blob/master/buds/02.md).

## Install

```bash
npm i @nostr-wot/blossom nostr-tools
```

## Upload

Supply any signer exposing an asynchronous `signEvent` method, including the signers in `@nostr-wot/signers`:

```ts
import { uploadToBlossom } from "@nostr-wot/blossom";
import { Nip07Signer } from "@nostr-wot/signers";

const blob = await uploadToBlossom(file, {
  signer: new Nip07Signer(),
  servers: ["https://my.blossom", "https://blossom.primal.net"],
});
// { url, sha256, size, type, uploaded }
```

Inputs may be `File`, `Blob`, `ArrayBuffer`, or `Uint8Array`. Mutable inputs are copied before the first asynchronous operation so the signed hash always describes the uploaded bytes. The MIME type comes from `contentType`, then the Blob/File type; an empty or missing type becomes `application/octet-stream`. Auth lifetime defaults to 3,600 seconds and can be set with `authExpirySec` (finite, at least one second; fractions are rounded down).

The default servers are `https://blossom.primal.net`, `https://nostr.build`, and `https://blossom.band`. HTTP errors, network errors, malformed JSON, and invalid descriptors trigger ordered fallback. Upload redirects are rejected so bytes and authorization are never forwarded outside the explicitly selected server list. Accepted descriptors must name the exact uploaded hash in the URL's final path segment (with an optional extension), match the hash and size, and contain a valid MIME type and nonnegative integer upload timestamp. Public uploads permit HTTP or HTTPS; credentials in URLs are rejected. An empty server list fails without signing.

Public uploads use one signature across servers by default. Set `bindAuthToServer: true` to sign separately for each destination. The `server` tag contains its lowercase hostname, without a port, as required by BUD-11. Signer rejection propagates immediately instead of prompting again for the next server.

## Encrypted attachments

Encrypt the attachment before calling this helper. It creates a fresh disposable signing identity for each upload, uses that identity across its fallback attempts, and scopes each authorization to the destination server. Both upload destinations and returned URLs must use HTTPS. The body is sent as `application/octet-stream`.

```ts
import { uploadEncryptedBlob } from "@nostr-wot/blossom";

const blob = await uploadEncryptedBlob(ciphertext, {
  servers: ["https://my.blossom", "https://blossom.primal.net"],
});
```

The server still sees the ciphertext size, hash, IP address, and request timing. This helper does not encrypt content or hide network metadata.

## Cancellation and session changes

Both upload functions accept `signal` and `assertActive`. A signal is forwarded to fetch. The synchronous `assertActive` callback should throw when a session or operation becomes obsolete; it is checked before and after asynchronous steps and before fallback. These failures propagate without trying another server. An already pending signer or Blob read cannot itself be cancelled; the result is discarded when it resolves.

```ts
const blob = await uploadToBlossom(file, {
  signer,
  signal: controller.signal,
  assertActive: () => {
    if (session !== currentSession()) throw new Error("Session changed");
  },
});
```

When all servers fail, `BlossomUploadError` exposes a readonly `reasons` array containing server diagnostics. Applications should map it to their own user-facing message.

## Mirror

Mirroring downloads the original bytes and uploads to each target, returning descriptors for successful copies. Individual target failures do not discard successful results; a failure downloading the source rejects the operation.

```ts
import { mirrorBlob } from "@nostr-wot/blossom";

const copies = await mirrorBlob(existingBlob.url, {
  signer,
  targetServers: ["https://blossom.band", "https://nostr.build"],
});
// BlossomBlob[]
```

## Delete

Deletion returns the server's success status. The authorization is scoped to that server. A server may retain a blob referenced by other users.

```ts
import { deleteBlob } from "@nostr-wot/blossom";

const deleted = await deleteBlob(blob.sha256, {
  signer,
  server: new URL(blob.url).origin,
});
```

## Types

```ts
type BlossomBlob = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
};
```

## License

MIT
