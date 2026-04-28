# @nostr-wot/blossom

[Blossom](https://github.com/hzrd149/blossom) helpers for Nostr — content-addressed file hosting with kind-24242 BUD-01 signed auth. Upload, mirror across servers, delete.

## Install

```bash
npm i @nostr-wot/blossom @nostr-wot/signers nostr-tools
```

## Upload

```ts
import { uploadToBlossom } from "@nostr-wot/blossom";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const blob = await uploadToBlossom(file, { signer });
// → { url, sha256, size, type, uploaded }
// blob.url is e.g. https://blossom.primal.net/<sha256>.<ext>
```

By default, the SDK tries a curated server list in order — `blossom.primal.net`, `cdn.nostr.build`, `blossom.band` — and returns the first 2xx. Override with your own:

```ts
const blob = await uploadToBlossom(file, {
  signer,
  servers: ["https://my.blossom", "https://blossom.primal.net"],
});
```

## Mirror

Backup an already-uploaded blob to additional servers — Blossom is content-addressed, so any server hosting the same SHA-256 returns the same content.

```ts
import { mirrorBlob } from "@nostr-wot/blossom";

const results = await mirrorBlob(existingBlob.url, {
  signer,
  servers: ["https://blossom.band", "https://cdn.nostr.build"],
});
// → [{ server, ok, url? } | { server, ok: false, error }]
```

## Delete

Best-effort — Blossom servers may keep blobs that other users have also uploaded.

```ts
import { deleteBlob } from "@nostr-wot/blossom";

await deleteBlob(blob.sha256, {
  signer,
  servers: [blob.url.split("/").slice(0, 3).join("/")],
});
```

## Auth (BUD-01)

Every Blossom request is signed with a kind-24242 event. The SDK builds + signs the event with your `NostrSigner` and attaches it via the `Authorization` header. You don't need to construct the auth event manually — it's transparent.

If you need access to the raw event for debugging:

```ts
import { buildBlossomAuthEvent } from "@nostr-wot/blossom";

const authEvent = await buildBlossomAuthEvent(signer, {
  kind: "upload",     // "upload" | "delete" | "list" | "get"
  fileSha256: hex,
  expiration: Math.floor(Date.now() / 1000) + 60,
});
```

## Types

```ts
interface BlossomBlob {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}
```

## License

MIT
