/**
 * One-off generator for the golden vector in `test/fixtures/`.
 *
 * This script deliberately shares NOTHING with `@nostr-wot/vault`. It imports nothing from
 * `../src`, and reimplements the browser extension's own vault writer line for line against
 * Node's WebCrypto:
 *
 *   - `src/services/vault/encryption.ts` -> `deriveKey` (PBKDF2-HMAC-SHA-256 -> AES-GCM 256)
 *     and `encrypt` (12 byte random IV, tag appended, which is what WebCrypto returns).
 *   - `src/services/vault/vault.ts` -> `create()`: a 32 byte random salt, `iterationsFor(password)`,
 *     `JSON.stringify({ ...payload, cacheKey })`, and the record shape
 *     `{ version, iterations, salt, iv, ciphertext }` with the three byte fields base64.
 *   - `src/lib/crypto/utils.ts` -> `arrayToBase64`, reproduced here with Buffer, which
 *     produces the identical standard-with-padding alphabet `btoa` does.
 *
 * That independence is the whole point. A fixture produced by calling `sealPayload` would
 * only prove `sealPayload` is self-consistent; this one proves two implementations written
 * from the same spec agree on the bytes.
 *
 * Run with: node packages/vault/scripts/generate-extension-fixture.mjs
 * The output is committed, so there is no reason to re-run it unless the format changes.
 */
import { webcrypto } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'test', 'fixtures');

// ── verbatim from the extension ────────────────────────────────────────────────

/** `@constants/vault.ts` */
const VAULT_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_ITERATIONS_LEGACY = 210_000;

/** `src/lib/crypto/utils.ts` — `arrayToBase64`, via Buffer rather than btoa. */
const arrayToBase64 = (arr) => Buffer.from(arr).toString('base64');

/** `src/services/vault/encryption.ts` — `iterationsFor`. */
const iterationsFor = (password) =>
  password.length > 0 ? PBKDF2_ITERATIONS : PBKDF2_ITERATIONS_LEGACY;

/** `src/services/vault/encryption.ts` — `deriveKey`. */
async function deriveKey(password, salt, iterations) {
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `src/services/vault/encryption.ts` — `encrypt`. */
async function encrypt(key, plaintext) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  return { iv, ciphertext };
}

/**
 * `src/services/vault/vault.ts` — `create()`, reduced to the part that builds the record.
 *
 * `legacy` writes the record the way it looked before the work factor was raised: the
 * `iterations` field did not exist yet and every such vault was written at 210000.
 */
async function createRecord(password, payload, { legacy = false } = {}) {
  const salt = webcrypto.getRandomValues(new Uint8Array(32));
  const iterations = legacy ? PBKDF2_ITERATIONS_LEGACY : iterationsFor(password);
  const key = await deriveKey(password, salt, iterations);
  const cacheKey =
    payload.cacheKey || arrayToBase64(webcrypto.getRandomValues(new Uint8Array(32)));
  const stored = { ...payload, cacheKey };
  const { iv, ciphertext } = await encrypt(key, JSON.stringify(stored));
  const record = {
    version: VAULT_VERSION,
    ...(legacy ? {} : { iterations }),
    salt: arrayToBase64(salt),
    iv: arrayToBase64(iv),
    ciphertext: arrayToBase64(ciphertext),
  };
  return { record, stored };
}

// ── the payload ───────────────────────────────────────────────────────────────

const PASSWORD = 'correct horse battery staple';

/**
 * Two accounts on purpose: one seeded (mnemonic present, the interesting case for
 * `mnemonicBytes`) and one imported from an nsec with no mnemonic at all. The second one
 * also carries `walletConfig`, a field the extension stores and this package deliberately
 * does not model — it has to survive untouched or real vaults get corrupted on save.
 */
const PAYLOAD = {
  cacheKey: arrayToBase64(new Uint8Array(32).fill(0x2b)),
  accounts: [
    {
      id: 'acct_seeded',
      name: 'Main',
      type: 'generated',
      pubkey: 'ab'.repeat(32),
      privkey: 'cd'.repeat(32),
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
      nip46Config: null,
      readOnly: false,
      createdAt: 1727136000000,
      derivationIndex: 0,
      derivationPath: "m/44'/1237'/0'/0/0",
    },
    {
      id: 'acct_imported',
      name: 'Imported nsec',
      type: 'nsec',
      pubkey: 'ef'.repeat(32),
      privkey: '01'.repeat(32),
      mnemonic: null,
      nip46Config: null,
      readOnly: false,
      createdAt: 1727136500000,
      walletConfig: { provider: 'nwc', connectionString: 'nostr+walletconnect://deadbeef' },
    },
  ],
  activeAccountId: 'acct_seeded',
};

// ── write ─────────────────────────────────────────────────────────────────────

mkdirSync(FIXTURES, { recursive: true });

const strong = await createRecord(PASSWORD, PAYLOAD);
writeFileSync(join(FIXTURES, 'extension-vault-v1.json'), `${JSON.stringify(strong.record, null, 2)}\n`);
writeFileSync(
  join(FIXTURES, 'extension-vault-v1.plaintext.json'),
  `${JSON.stringify({ password: PASSWORD, payload: strong.stored }, null, 2)}\n`,
);

const legacy = await createRecord(PASSWORD, PAYLOAD, { legacy: true });
writeFileSync(
  join(FIXTURES, 'extension-vault-v1-no-iterations.json'),
  `${JSON.stringify(legacy.record, null, 2)}\n`,
);
writeFileSync(
  join(FIXTURES, 'extension-vault-v1-no-iterations.plaintext.json'),
  `${JSON.stringify({ password: PASSWORD, payload: legacy.stored }, null, 2)}\n`,
);

console.log('wrote 4 files to', FIXTURES);
