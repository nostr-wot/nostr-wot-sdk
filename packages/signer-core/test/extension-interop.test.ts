/**
 * Interoperability with the browser extension, asserted rather than assumed.
 *
 * The extension is the specification for this package's post-quantum support, and the property
 * the whole feature exists for is that the two halves agree on the wire: a message the extension
 * seals opens here, a message sealed here opens there, and an attestation signed by either is
 * verifiable by the other. Nothing else in this suite can see that. Every other post-quantum
 * test uses `@nostr-wot/pq` on both sides of the round trip, which proves only that this repo
 * agrees with itself — so if the envelope's framing, an HKDF `info` string, the associated data
 * layout or a tag order drifts, this file is the only thing that notices.
 *
 * The extension's own `src/lib/crypto/pq.ts` runs in a child process through
 * `extension-interop-probe.mjs`, which copies that file and its dependency closure out of the
 * checkout, rewrites their path aliases and imports the copies. Nothing runs inside the
 * extension checkout and nothing there is modified. The probe's doc comment has the details,
 * including which parts of the stack are genuinely independent and which are shared.
 *
 * **When the checkout is absent this suite SKIPS, loudly, and says so.** A machine without the
 * extension beside this repo cannot verify interoperability, and pretending otherwise with a
 * test that passes vacuously is exactly the kind of verification-that-verifies-nothing this
 * project keeps finding. Set `NOSTR_WOT_INTEROP=required` to make the absence a failure
 * instead, which is what CI should do once the checkout is available to it.
 */
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveFromMnemonic, mnemonicToSeed } from '@nostr-wot/accounts';
import { ALG_DSA, ALG_KEM, PQ_PROFILE, PQC_KIND, derivePqKeys, fromBase64, toBase64 } from '@nostr-wot/pq';
import { SignerError, verifyPqAttestation } from '../src/index.js';
import { account, fixture, req, PUBKEY_2 } from './harness.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PROBE = join(import.meta.dirname, 'extension-interop-probe.mjs');

/**
 * Where the extension checkout might be.
 *
 * `NOSTR_WOT_EXTENSION` is authoritative: if it is set and does not hold the sources, the answer
 * is "not found" rather than a quiet fall back to a checkout somewhere else. Someone who names a
 * directory wants that directory, and a pointer that is silently overridden is how a run ends up
 * verifying against a copy nobody meant. Otherwise the sibling layout the workspace uses, from a
 * normal clone and from a worktree one or two levels deeper.
 *
 * A candidate counts only if it holds the file the probe needs, so a same-named directory that
 * is something else cannot masquerade as it.
 */
const OVERRIDE = process.env['NOSTR_WOT_EXTENSION'];
const CANDIDATES =
  typeof OVERRIDE === 'string' && OVERRIDE.length > 0
    ? [OVERRIDE]
    : ['../nostr-wot-extension', '../../nostr-wot-extension', '../../../nostr-wot-extension'];

function findExtension(): string | null {
  for (const candidate of CANDIDATES) {
    const dir = isAbsolute(candidate) ? candidate : resolve(REPO_ROOT, candidate);
    if (existsSync(join(dir, 'src', 'lib', 'crypto', 'pq.ts'))) return dir;
  }
  return null;
}

const EXTENSION = findExtension();
const REQUIRED = process.env['NOSTR_WOT_INTEROP'] === 'required';

if (EXTENSION === null) {
  // On the run output, not only in a skipped test's name, so it cannot pass unnoticed.
  process.stderr.write(
    `\n${'='.repeat(78)}\n` +
      'INTEROPERABILITY UNVERIFIED: the nostr-wot-extension checkout was not found.\n' +
      'The extension is the specification for post-quantum support here, and this run did\n' +
      'NOT check that the two implementations still agree on the wire. Looked in:\n' +
      `${CANDIDATES.map((candidate) => `  - ${candidate}`).join('\n')}\n` +
      'Set NOSTR_WOT_EXTENSION to the checkout, or NOSTR_WOT_INTEROP=required to fail\n' +
      'instead of skipping.\n' +
      `${'='.repeat(78)}\n\n`,
  );
}

type ProbeResult = Record<string, string | boolean>;

/**
 * One batch of operations through the extension's own code.
 *
 * A failure inside the extension's crypto — which is what a wire drift looks like from this side
 * — comes back as the probe's own message rather than as "Command failed", because the child's
 * stdout is read on the error path too. The whole value of this file is that a failure here
 * names what disagreed; a generic spawn error would send the reader to the harness instead.
 */
function probe(...ops: Array<Record<string, unknown>>): ProbeResult[] {
  let raw: string;
  try {
    raw = execFileSync(process.execPath, [PROBE, EXTENSION as string], {
      input: JSON.stringify({ ops }),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const out = (error as { stdout?: string }).stdout ?? '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const reported = out.trim().split('\n').at(-1) ?? '';
    let message = stderr.trim() || (error as Error).message;
    try {
      const parsed = JSON.parse(reported) as { error?: string };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // Not JSON: the child died before it could report, so the raw output is the best we have.
    }
    throw new Error(`the extension's own crypto refused this: ${message}`);
  }
  const answer = JSON.parse(raw.trim().split('\n').at(-1)!) as
    | { ok: true; results: ProbeResult[] }
    | { ok: false; error: string };
  if (!answer.ok) throw new Error(`the extension's own crypto refused this: ${answer.error}`);
  return answer.results;
}

const text = (result: ProbeResult, key: string): string => {
  const value = result[key];
  if (typeof value !== 'string') throw new Error(`probe result has no string ${key}`);
  return value;
};
const flag = (result: ProbeResult, key: string): boolean => {
  const value = result[key];
  if (typeof value !== 'boolean') throw new Error(`probe result has no boolean ${key}`);
  return value;
};

/** The 24-word phrase every post-quantum test in this package uses. */
const M24 =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';

const seeded = () => {
  const derived = deriveFromMnemonic(M24, 0);
  return account('acct_seed', bytesToHex(derived.privkey), {
    type: 'generated',
    mnemonic: M24,
    derivationIndex: 0,
    derivationPath: derived.path,
  });
};

/** The extension's keys for this seed at `index`, as base64, straight from its own deriver. */
const theirKeys = (index: number): ProbeResult => {
  const seed = mnemonicToSeed(M24);
  try {
    return probe({ kind: 'derive', seed: toBase64(seed), account: index })[0]!;
  } finally {
    seed.fill(0);
  }
};

/** Ours for the same seed, through `@nostr-wot/pq`. */
const ourKeys = (index: number) => {
  const seed = mnemonicToSeed(M24);
  try {
    return derivePqKeys(seed, index);
  } finally {
    seed.fill(0);
  }
};

/** Someone else, with a NIP-44 conversation key to `ourPubkey`. */
function peer(ourPubkey: string) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, pk, conversationKey: nip44.v2.utils.getConversationKey(sk, ourPubkey) };
}

test('the extension checkout was located, so the interop assertions below are not vacuous', () => {
  // Under NOSTR_WOT_INTEROP=required this is the test that fails when nobody can verify
  // interoperability. Otherwise it records the state of the run; the banner above is the loud
  // half, and the suite below shows as skipped.
  if (REQUIRED) {
    expect(EXTENSION, 'NOSTR_WOT_INTEROP=required and no extension checkout was found').not.toBeNull();
  }
  expect(EXTENSION === null || existsSync(join(EXTENSION, 'src', 'lib', 'crypto', 'pq.ts'))).toBe(true);
});

describe.skipIf(EXTENSION === null)('interoperability with nostr-wot-extension', () => {
  test('both implementations derive the same ML-KEM-1024 and ML-DSA-87 keys from one seed', () => {
    for (const index of [0, 3]) {
      const ours = ourKeys(index);
      const theirs = theirKeys(index);
      expect(text(theirs, 'kemPublic'), `index ${index}`).toBe(toBase64(ours.kem.publicKey));
      expect(text(theirs, 'dsaPublic'), `index ${index}`).toBe(toBase64(ours.dsa.publicKey));
    }
  });

  test("the extension's pqEncrypt output decrypts through this pipeline, routed post-quantum", async () => {
    const acct = seeded();
    const { core, activity } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const sealed = probe({
      kind: 'encrypt',
      plaintext: 'from the extension',
      recipientKem: text(theirKeys(0), 'kemPublic'),
      conversationKey: toBase64(from.conversationKey),
      sender: from.pk,
      recipient: acct.pubkey,
    })[0]!;

    const plaintext = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: text(sealed, 'payload') }));

    expect(plaintext).toBe('from the extension');
    // Not merely "it opened": it took the hybrid route, which is what the activity log tells the
    // user and what a silent downgrade would have hidden.
    expect(activity.entries.at(-1)).toMatchObject({ method: 'nip44Decrypt', decision: 'allow', scheme: 'pq' });
  });

  test("this pipeline's opts: pq output decrypts with the extension's pqDecrypt", async () => {
    const acct = seeded();
    const { core } = await fixture(true, { accounts: [acct] });
    const to = peer(acct.pubkey);
    const recipient = theirKeys(3);

    const ciphertext = (await core.handle(
      req('nip44Encrypt', {
        pubkey: to.pk,
        plaintext: 'from the shared core',
        opts: { scheme: 'pq', recipientKemKey: text(recipient, 'kemPublic') },
      }),
    )) as string;

    const [opened, recognised] = probe(
      {
        kind: 'decrypt',
        payload: ciphertext,
        kemSecret: text(recipient, 'kemSecret'),
        conversationKey: toBase64(to.conversationKey),
        sender: acct.pubkey,
        recipient: to.pk,
      },
      { kind: 'isEnvelope', payload: ciphertext },
    );
    expect(text(opened!, 'plaintext')).toBe('from the shared core');
    expect(flag(recognised!, 'isEnvelope')).toBe(true);
  });

  test("an attestation signed here has a proof of possession the extension's verifyPop accepts", async () => {
    const acct = seeded();
    const { core } = await fixture(true, { accounts: [acct] });
    const event = (await core.handle(req('signPqAttestation'))) as Event;
    const alg = (name: string) => event.tags.find((tag) => tag[0] === 'alg' && tag[1] === name)![2]!;

    const verdict = probe({
      kind: 'verifyPop',
      pubkey: event.pubkey,
      kem: alg(ALG_KEM),
      dsa: alg(ALG_DSA),
      pop: event.tags.find((tag) => tag[0] === 'pop')![2]!,
    })[0]!;
    expect(flag(verdict, 'valid')).toBe(true);
  });

  test('an attestation whose proof of possession the extension signed verifies here', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const keys = theirKeys(7);
    const kem = text(keys, 'kemPublic');
    const dsa = text(keys, 'dsaPublic');
    const pop = text(probe({ kind: 'signPop', pubkey, kem, dsa, dsaSecret: text(keys, 'dsaSecret') })[0]!, 'pop');

    const event = JSON.parse(
      JSON.stringify(
        finalizeEvent(
          {
            kind: PQC_KIND,
            created_at: 1,
            content: '',
            tags: [
              ['alg', ALG_KEM, kem],
              ['alg', ALG_DSA, dsa],
              ['origin', 'derived'],
              ['seed_strength', '256'],
              ['v', PQ_PROFILE],
              ['pop', ALG_DSA, pop],
            ],
          },
          sk,
        ),
      ),
    ) as Event;

    const verified = verifyPqAttestation(event);
    expect(verified.problems.map((problem) => problem.code)).toEqual([]);
    expect(verified.usable).toBe(true);
    expect(verified.popValid).toBe(true);
    expect(verified.kem).toEqual(fromBase64(kem));
  });

  test("the route this pipeline takes matches what the extension's isPqEnvelope says", async () => {
    // The round that added `classifyEnvelope` could have changed which payloads take the hybrid
    // route. This is the check that it did not: the extension decides, every payload it calls an
    // envelope must open here, and one it does not must not be claimed as one.
    const acct = seeded();
    const { core } = await fixture(true, { accounts: [acct] });
    const from = peer(acct.pubkey);
    const hybrid = text(
      probe({
        kind: 'encrypt',
        plaintext: 'hybrid',
        recipientKem: text(theirKeys(0), 'kemPublic'),
        conversationKey: toBase64(from.conversationKey),
        sender: from.pk,
        recipient: acct.pubkey,
      })[0]!,
      'payload',
    );
    const classic = nip44.v2.encrypt('classic', from.conversationKey);
    const truncated = toBase64(fromBase64(hybrid).subarray(0, 100));

    const verdicts = probe(
      { kind: 'isEnvelope', payload: hybrid },
      { kind: 'isEnvelope', payload: classic },
      { kind: 'isEnvelope', payload: truncated },
    );
    expect(verdicts.map((verdict) => flag(verdict, 'isEnvelope'))).toEqual([true, false, false]);

    expect(await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: hybrid }))).toBe('hybrid');
    expect(await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: classic }))).toBe('classic');
    // Neither implementation can open the truncated one. The difference is what we say about it:
    // the extension's boolean cannot distinguish it from a classic payload, and this pipeline
    // refuses it as the post-quantum payload its header declares it to be.
    const refusal = await core.handle(req('nip44Decrypt', { pubkey: from.pk, ciphertext: truncated })).catch((e: unknown) => e);
    expect((refusal as SignerError).message).toBe('This post-quantum payload is not a readable hybrid envelope');
  });

  test('the probe cannot make this pipeline sign for an account that has no key', async () => {
    // Guards the harness rather than the wire: if this suite could sign for any account, the
    // agreements above would be about nothing.
    const { core } = await fixture(true, { accounts: [account('acct_watch', null, { pubkey: PUBKEY_2 })] });
    const error = await core.handle(req('signPqAttestation')).catch((e: unknown) => e);
    expect((error as SignerError).code).toBe('unsupported');
    expect((error as SignerError).message).toBe('This account has no signing key');
  });
});
