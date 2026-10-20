# @nostr-wot/identity/accounts

> Package consolidation: this is the API guide for `@nostr-wot/identity/accounts`. The former `@nostr-wot/accounts` package is a deprecated compatibility re-export. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

The Nostr account primitives every `@nostr-wot/*` host shares: NIP-06 key derivation, import classification and NIP-49 encrypted keys, in pure JavaScript.

The point of this package is that it needs no browser. Nothing in `src/` touches `crypto.subtle`, `chrome`, `window`, `localStorage`, React or React Native, so the same derivation the browser extension performs runs unchanged in a React Native app and in a Node test. It is a port of the extension's `src/domain/accounts/` and the relevant halves of `src/lib/crypto/`, not a reimplementation from the NIPs: the account records and ncryptsec files users already hold were written by that code, so the parameters are copied rather than re-derived.

## Install

```bash
npm i @nostr-wot/identity
```

### Module format

Use ESM `import` as shown here. Module-format support is specific to the owning package and entry point; do not infer it from another package in the family. The identity entry points are ESM-only.

## Derivation (NIP-06)

```ts
import { deriveFromMnemonic, derivationPath, generateMnemonic } from '@nostr-wot/identity/accounts';

const mnemonic = generateMnemonic();            // 24 words; pass 128 for 12
derivationPath(3);                              // "m/44'/1237'/0'/0/3"

const { privkey, pubkey, path } = deriveFromMnemonic(mnemonic, 0);
// privkey is live key material — zero it once the account is built.
privkey.fill(0);
```

`generateMnemonic()` defaults to 256 bits rather than BIP-39's 128-bit minimum. Post-quantum keys are derived from the same seed, and at 12 words the seed, not the algorithm, becomes the weakest link.

### Sub-account paths: read this before changing them

Sub-account `n` is at **`m/44'/1237'/0'/0/{n}`** — the last component varies, the account component stays at `0'`. Some other signers vary the account component instead, deriving `m/44'/1237'/{n}'/0/0`, which is the stricter reading of NIP-06.

This package follows the browser extension, deliberately, because the extension has shipped. Someone who created sub-accounts there and then restores the same seed phrase in the mobile app has to get the same identities back. Deriving the other way would hand them a different set of keys with no error at all, and the only reasonable conclusion they could draw is that their accounts were lost. Protocol purity loses to not destroying identities that already exist.

Index 0 is `m/44'/1237'/0'/0/0` under either convention, so the published NIP-06 test vector holds regardless. The two only diverge from index 1 onward.

`standardDerivationIndex(derivationPath(n)) === n` for every valid `n`; that round-trip is what lets a stored path recover its account index, and it is covered by a test.

## Import

`parseImportInput` validates; it does not merely match a prefix. It returns `null` for a bech32 string whose checksum does not hold, an `nsec` or hex key whose bytes are not a valid secp256k1 scalar, an `npub` whose x-coordinate is not on the curve, and an `ncryptsec` with an unknown version byte or a payload of the wrong length. Every one of those is material that looks importable and is not: an accepted-but-wrong npub becomes a watch-only account pointing at a pubkey nobody holds, and the import screen is the last moment anyone can be told.

```ts
import { parseImportInput } from '@nostr-wot/identity/accounts';

parseImportInput('nsec1…');        // { kind: 'nsec', privkey }
parseImportInput('npub1…');        // { kind: 'npub', pubkey }
parseImportInput('ncryptsec1…');   // { kind: 'ncryptsec', payload }
parseImportInput('bunker://<64 hex>?relay=…'); // { kind: 'bunker', uri }
parseImportInput('<64 hex>');      // { kind: 'hex-private', privkey }
parseImportInput('twelve or twenty four words…'); // { kind: 'mnemonic', mnemonic }
parseImportInput('npub1qqqq…');    // null — bad checksum
parseImportInput('0'.repeat(64));  // null — not a valid secp256k1 scalar
// null — an npub whose x-coordinate has no point on the curve
```

### `detectImportKind` — for the error message, never for the decision

Strict parsing alone leaves the UI with nothing useful to say. A seed phrase with one mistyped word is, to `parseImportInput`, indistinguishable from random text, and "unrecognized input" is a cruel message to show someone in the middle of recovering an identity.

`detectImportKind` classifies by shape and validates nothing, so the caller can name what the user was evidently trying to paste:

```ts
import { detectImportKind, parseImportInput } from '@nostr-wot/identity/accounts';

const input = 'ladder monkey parrot …';   // one word mistyped
parseImportInput(input);                  // null      — do not import this
detectImportKind(input);                  // 'mnemonic' — "that seed phrase has a typo"
```

Never branch on `detectImportKind` to decide that material is usable. That is what `parseImportInput` is for.

## NIP-49 (ncryptsec)

| Parameter | Value |
| --- | --- |
| KDF | scrypt, N = 2^16, r = 8, p = 1, dkLen = 32 |
| Password | NFKC-normalized |
| Cipher | XChaCha20-Poly1305, key_security_byte as AAD |
| Payload | version(1) + log_n(1) + salt(16) + nonce(24) + key_security(1) + ciphertext(48) |

```ts
import { decryptNcryptsec, encryptNcryptsec } from '@nostr-wot/identity/accounts';

const encoded = encryptNcryptsec(privkey, password);
const recovered = decryptNcryptsec(encoded, password); // throws on the wrong password
```

Decoding also accepts the legacy local-only `0x01` format the extension used to export (PBKDF2-SHA256 at 210 000 iterations plus AES-256-GCM), so older backups still import. Nothing writes that format any more.

`privkey` is **borrowed**: the bytes are not zeroed here, because an export runs inside a `withPrivkey` scope that owns the copy and zeroes it, and zeroing it here as well would blank that scope's key underneath it. Bytes are the only accepted form, and `decryptNcryptsec` returns bytes too, so nothing rounds a key through a string: a string cannot be overwritten, so building one leaves a second copy of the key in the heap that nothing can zero.

The `logn` argument on `encryptNcryptsec` can only raise the scrypt cost above the default (`MIN_LOG_N = DEFAULT_LOG_N = 16`, 64 MiB, what the extension writes and NIP-49 recommends); anything lower is refused. A backup leaves the device and can be guessed at offline indefinitely, so the cost of a guess is its whole protection. `decryptNcryptsec` still opens a backup another client wrote at a lower cost, since that file is theirs to have written weakly.

### The scrypt memory bound

`scryptMaxMem(logN)` is the `maxmem` handed to `@noble/hashes`, and it is deliberately a few blocks above what the algorithm needs rather than equal to what any one noble version checks. It has been equal twice, and broke twice. `128·r·(N + p)` is 2.0.1's expression, and 2.2.0 started counting a scratch block it had always allocated, so every encode and decode threw `"maxmem" limit was hit` for anyone who resolved from the declared range instead of a lockfile. The repair, `128·r·(N + p + 1)`, is 2.4.0's expression: same coupling, one version along, zero room for the next revision.

`SCRYPT_MAXMEM_SLACK_BLOCKS` is that room, four blocks, which is 4 KiB beside a `V` table of N blocks. It is a compatibility bound and not a safety one: it is computed from the cost factor in the payload, so it can never reject an expensive backup. `MAX_LOG_N` is what bounds that.

The general rule this leaves behind: a numeric bound handed to a library must be derived from what the algorithm or format requires, never copied from what a particular version of that library happens to check, and never pinned exactly to it. The two agree right up until the library revises its own accounting, and a lockfile-pinned suite cannot tell you when that happens. `test/scrypt-maxmem.test.ts` asks the installed library what it requires instead of restating anyone's arithmetic, and `.github/workflows/deps-in-range.yml` runs the suite against the newest version each declared range admits.

## The committed derivation fixture

`test/fixtures/nip06-vectors.json` pins the NIP-06 mnemonic and the derived keys for indexes 0, 1, 3 and 7 in the extension-compatible layout, and a test asserts `deriveFromMnemonic` reproduces every row. An edit that "corrects" the path convention breaks all four rows instead of silently handing existing users a different set of identities. Index 0 is the published NIP-06 vector, so the fixture is anchored to the spec and not only to this implementation.

The other half of the guard — a mirror test in `nostr-wot-extension` reading this same file — is what would actually catch a cross-repo divergence. It belongs to the extension migration phase and is not in this package. Keep the two copies byte-identical when it lands.

## Host requirements

The portable account, vault, permission and signing modules use injected storage and host ports. They require `TextEncoder`, `TextDecoder`, secure `crypto.getRandomValues`, timers and `AbortController`; post-quantum paths additionally require `atob`/`btoa` or the supported Buffer fallback. Initialize the necessary React Native/Hermes polyfills before importing these modules, including `react-native-get-random-values` for secure randomness. Do not substitute a non-cryptographic random source.

The portable cryptographic core does not require the DOM, WebExtension APIs or WebCrypto `subtle`. Platform adapters such as WebAuthn ceremonies and relay transports have their own requirements. See the [identity runtime guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/identity/README.md#runtime-requirements).

This package uses `TextEncoder` directly (NIP-49 password bytes) and `@noble` throughout.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
