# @nostr-wot/accounts

The Nostr account primitives every `@nostr-wot/*` host shares: NIP-06 key derivation, import
classification and NIP-49 encrypted keys, in pure JavaScript.

The point of this package is that it needs no browser. Nothing in `src/` touches
`crypto.subtle`, `chrome`, `window`, `localStorage`, React or React Native, so the same
derivation the browser extension performs runs unchanged in a React Native app and in a Node
test. It is a port of the extension's `src/domain/accounts/` and the relevant halves of
`src/lib/crypto/`, not a reimplementation from the NIPs: the account records and ncryptsec
files users already hold were written by that code, so the parameters are copied rather than
re-derived.

## Install

```bash
npm i @nostr-wot/accounts
```

## Derivation (NIP-06)

```ts
import { deriveFromMnemonic, derivationPath, generateMnemonic } from '@nostr-wot/accounts';

const mnemonic = generateMnemonic();            // 24 words; pass 128 for 12
derivationPath(3);                              // "m/44'/1237'/3'/0/0"

const { privkey, pubkey, path } = deriveFromMnemonic(mnemonic, 0);
// privkey is live key material — zero it once the account is built.
privkey.fill(0);
```

`generateMnemonic()` defaults to 256 bits rather than BIP-39's 128-bit minimum. Post-quantum
keys are derived from the same seed, and at 12 words the seed, not the algorithm, becomes the
weakest link.

## Import

`parseImportInput` validates; it does not merely match a prefix. A bech32 string whose checksum
does not hold returns `null`, because an accepted-but-wrong npub becomes a watch-only account
pointing at a pubkey nobody holds, and the user finds out weeks later.

```ts
import { parseImportInput } from '@nostr-wot/accounts';

parseImportInput('nsec1…');        // { kind: 'nsec', privkey }
parseImportInput('npub1…');        // { kind: 'npub', pubkey }
parseImportInput('ncryptsec1…');   // { kind: 'ncryptsec', payload }
parseImportInput('bunker://<64 hex>?relay=…'); // { kind: 'bunker', uri }
parseImportInput('<64 hex>');      // { kind: 'hex-private', privkey }
parseImportInput('twelve or twenty four words…'); // { kind: 'mnemonic', mnemonic }
parseImportInput('npub1qqqq…');    // null — bad checksum
```

## NIP-49 (ncryptsec)

| Parameter | Value |
| --- | --- |
| KDF | scrypt, N = 2^16, r = 8, p = 1, dkLen = 32 |
| Password | NFKC-normalized |
| Cipher | XChaCha20-Poly1305, key_security_byte as AAD |
| Payload | version(1) + log_n(1) + salt(16) + nonce(24) + key_security(1) + ciphertext(48) |

```ts
import { decryptNcryptsec, encryptNcryptsec } from '@nostr-wot/accounts';

const encoded = encryptNcryptsec(privkey, password);
const recovered = decryptNcryptsec(encoded, password); // throws on the wrong password
```

Decoding also accepts the legacy local-only `0x01` format the extension used to export
(PBKDF2-SHA256 at 210 000 iterations plus AES-256-GCM), so older backups still import. Nothing
writes that format any more.

The `logn` argument on `encryptNcryptsec` exists for tests. Lowering it lowers the cost of
guessing the password.

## License

MIT
