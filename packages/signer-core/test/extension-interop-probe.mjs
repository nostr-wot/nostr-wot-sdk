/**
 * Runs the browser extension's OWN post-quantum crypto, for `extension-interop.test.ts`.
 *
 * The extension is the specification for this package's post-quantum support, and the only
 * verification that means anything is running its code against ours. So this script takes the
 * six files that make up `nostr-wot-extension/src/lib/crypto/pq.ts` and its dependency closure,
 * copies them out of that checkout, rewrites their `@domain/…` and `@constants/…` path aliases
 * to relative specifiers, and imports the copies. Nothing is executed inside the extension
 * checkout and nothing there is written to.
 *
 * It runs as a child process, not inside vitest, for one reason: the extension's sources are
 * `.ts` with explicit extensions, which Node strips natively (24+), so no bundler, transform
 * pipeline or alias configuration has to be taught about a directory outside this repo. The
 * test speaks to it in JSON — base64 payloads over stdin and stdout — and keeps every assertion
 * on the vitest side where a failure is named and visible.
 *
 * The copies land in this repo's gitignored `.interop-extension/`, so the extension's bare
 * imports (`@noble/post-quantum`, `@noble/ciphers`, `@noble/hashes`) resolve against OUR
 * installed versions. That is deliberate and worth knowing the shape of: what is under test is the
 * extension's own framing, derivation, associated data and padding logic, not whose copy of
 * ML-KEM runs underneath. Two different builds of a FIPS-203 primitive agreeing is not what
 * would break here; a header byte, an `info` string or an AD layout drifting is.
 *
 *   echo '{"ops":[…]}' | node test/extension-interop-probe.mjs <extension-dir>
 *
 * Prints one JSON line: `{"ok":true,"results":[…]}`, or `{"ok":false,"error":"…"}` and exit 1.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The extension files this needs, and the alias rewrites each one requires. */
const SOURCES = [
  {
    from: 'src/lib/crypto/pq.ts',
    to: 'ext-pq.ts',
    rewrite: [
      ['@domain/accounts/derivation.ts', './ext-derivation.ts'],
      ['@constants/crypto/pq.ts', './const-pq.ts'],
    ],
  },
  { from: 'src/lib/crypto/utils.ts', to: 'utils.ts', rewrite: [] },
  { from: 'src/constants/crypto/pq.ts', to: 'const-pq.ts', rewrite: [] },
  {
    from: 'src/domain/accounts/derivation.ts',
    to: 'ext-derivation.ts',
    rewrite: [
      ['@constants/derivation.ts', './const-derivation.ts'],
      ['@constants/crypto/bip32.ts', './const-bip32.ts'],
    ],
  },
  { from: 'src/constants/derivation.ts', to: 'const-derivation.ts', rewrite: [] },
  { from: 'src/constants/crypto/bip32.ts', to: 'const-bip32.ts', rewrite: [] },
];

/**
 * Where the rewritten copies go: inside this repo, so the extension's bare `@noble/*` imports
 * resolve by walking up to our `node_modules`, and NOT inside `node_modules` itself, because
 * Node refuses to strip types from a `.ts` file there. Gitignored.
 */
const CACHE = join(import.meta.dirname, '..', '..', '..', '.interop-extension');

function stage(extensionDir) {
  mkdirSync(CACHE, { recursive: true });
  for (const { from, to, rewrite } of SOURCES) {
    let source = readFileSync(join(extensionDir, from), 'utf8');
    for (const [alias, relative] of rewrite) {
      if (!source.includes(alias)) {
        // The extension moved a module. Loud, because a silently un-rewritten alias would fail
        // as "cannot find module" and look like a missing checkout rather than a drift.
        throw new Error(`${from} no longer imports ${alias}; the interop probe needs updating`);
      }
      source = source.split(alias).join(relative);
    }
    writeFileSync(join(CACHE, to), source);
  }
  return join(CACHE, 'ext-pq.ts');
}

const b64 = {
  encode: (bytes) => Buffer.from(bytes).toString('base64'),
  decode: (text) => new Uint8Array(Buffer.from(text, 'base64')),
};

async function main() {
  const extensionDir = process.argv[2];
  if (!extensionDir) throw new Error('usage: extension-interop-probe.mjs <extension-dir>');
  const entry = stage(extensionDir);
  const ext = await import(entry);

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { ops } = JSON.parse(input);

  const results = ops.map((op) => {
    switch (op.kind) {
      case 'derive': {
        const keys = ext.derivePqKeys(b64.decode(op.seed), op.account);
        return {
          kemPublic: b64.encode(keys.kem.publicKey),
          dsaPublic: b64.encode(keys.dsa.publicKey),
          kemSecret: b64.encode(keys.kem.secretKey),
          dsaSecret: b64.encode(keys.dsa.secretKey),
        };
      }
      case 'encrypt':
        return {
          payload: ext.pqEncrypt(
            op.plaintext,
            b64.decode(op.recipientKem),
            b64.decode(op.conversationKey),
            op.sender,
            op.recipient,
          ),
        };
      case 'decrypt':
        return {
          plaintext: ext.pqDecrypt(
            op.payload,
            b64.decode(op.kemSecret),
            b64.decode(op.conversationKey),
            op.sender,
            op.recipient,
          ),
        };
      case 'isEnvelope':
        return { isEnvelope: ext.isPqEnvelope(op.payload) };
      case 'verifyPop':
        // verifyPop(signature, message, dsaPublicKey) — signature first, in both packages.
        return {
          valid: ext.verifyPop(
            b64.decode(op.pop),
            ext.popMessage(op.pubkey, op.kem, op.dsa),
            b64.decode(op.dsa),
          ),
        };
      case 'signPop':
        return { pop: b64.encode(ext.signPop(ext.popMessage(op.pubkey, op.kem, op.dsa), b64.decode(op.dsaSecret))) };
      default:
        throw new Error(`unknown op ${String(op.kind)}`);
    }
  });

  process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
