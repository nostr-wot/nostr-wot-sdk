# @nostr-wot/vault

The vault cryptography every `@nostr-wot/*` host shares: PBKDF2-HMAC-SHA-256 key derivation and
AES-256-GCM, in pure JavaScript.

The point of this package is that it needs no WebCrypto. React Native has no `crypto.subtle`, so
a signer written against WebCrypto cannot be shared with a mobile app. This one produces and
consumes exactly the bytes the browser extension's WebCrypto implementation does, so a vault
written in the extension opens on a phone and the other way round. That byte compatibility is
covered by `test/webcrypto-compat.test.ts`, which checks both directions against
`node:crypto`'s WebCrypto.

## Install

```bash
npm i @nostr-wot/vault
```

## Format version 1

| Parameter | Value |
| --- | --- |
| KDF | PBKDF2-HMAC-SHA-256 |
| Iterations | 600000, or 210000 for the empty password |
| Cipher | AES-256-GCM |
| Salt | 16 bytes |
| IV | 12 bytes |

These are fixed. Vaults in the field were written with them, so changing one means a new format
version and a migration, not an edit.

## Usage

```ts
import { iterationsFor, noblePbkdf2, encrypt, decrypt } from '@nostr-wot/vault';

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await noblePbkdf2.derive(password, salt, iterationsFor(password));

const { iv, ciphertext } = encrypt(key, mnemonic);
const recovered = decrypt(key, iv, ciphertext); // throws if the key is wrong
```

`ciphertext` carries the 16-byte GCM tag appended, which is the layout WebCrypto returns and
expects. `decrypt` throws when the tag does not authenticate: a wrong key fails loudly rather
than returning plausible garbage.

## The empty password

`iterationsFor('')` returns the lower work factor on purpose. A "never lock" vault is stored
under a password the source code supplies in public, so anyone holding the encrypted blob also
holds the password and no amount of stretching makes it harder to open. The work factor buys
nothing there and only costs latency on a path that runs at every cold start. A vault with a
real password gets the full 600000, where stretching is the whole defence.

## `Pbkdf2Port`

Pure JavaScript PBKDF2 at 600000 iterations costs roughly a second on a phone. The default
`noblePbkdf2` is pure JavaScript so the package works everywhere with no native dependency; a
host that has a hardware accelerated PBKDF2 can implement the same interface and inject it.

```ts
interface Pbkdf2Port {
  derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
}
```

It is not on the common unlock path, which uses the hardware wrapped key rather than the
password.

## License

MIT
