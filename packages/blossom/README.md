# @nostr-wot/blossom

[Blossom](https://github.com/hzrd149/blossom) helpers for Nostr — content-addressed file hosting with kind-24242 BUD-01 signed auth.

```ts
import { uploadToBlossom } from "@nostr-wot/blossom";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const blob = await uploadToBlossom(file, { signer });
// blob.url is https://blossom.primal.net/<sha256>.<ext>
```

Tries the SDK's curated server list (`primal`, `nostr.build`, `blossom.band`) in order; first 2xx wins. Pass `servers: ["https://your.blossom"]` to override.

Also exports `mirrorBlob` (back up an existing blob to other servers) and `deleteBlob` (best-effort).

MIT.
