/**
 * One module format across the release.
 *
 * The six packages published together here (`storage`, `permissions`, `accounts`, `vault`,
 * `signer-core`, `bunker`) went into the consolidation with two different answers: the five
 * signer-stack packages were ESM only, while the bunker was dual ESM + CommonJS with a
 * `.d.cts`. A CommonJS consumer could `require('@nostr-wot/bunker')` and not
 * `require('@nostr-wot/signer-core')`, in one release, with nothing anywhere saying so, so the
 * place they would find out is a `require` that throws `ERR_REQUIRE_ESM`.
 *
 * The release is ESM only, and the bunker lost its CommonJS output rather than the other five
 * gaining one. Reasons, in order: a dual build can be loaded twice in one process, once per
 * format, and these packages hold state (a vault session with live key material, the bunker's
 * client and secret registries), so two copies is a security defect and not a packaging
 * inconvenience; the one consumer that vendors all six, the wallet, already imports the five
 * ESM-only tarballs the same way it imports the bunker; and a CommonJS caller still has
 * `await import()`.
 *
 * `@nostr-wot/pq` and `@nostr-wot/signers` are the deliberate exception: both were published
 * dual before this release, and taking CommonJS away from them would break consumers who have
 * it. That split is stated in each of the six READMEs so nobody meets it at `require` time.
 *
 * Lives beside `boundaries.test.ts` and `dist-freshness.test.ts`: one guard over all six.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The six packages this release publishes together. */
const RELEASE = ['storage', 'permissions', 'accounts', 'vault', 'signer-core', 'bunker'] as const;

/** Published dual before this release, and kept that way on purpose. */
const DUAL = ['pq', 'signers'] as const;

const manifestOf = (name: string) => JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));

describe('every package in the release has the same module format', () => {
  test.each(RELEASE)('%s is ESM only, in its manifest', (name) => {
    const manifest = manifestOf(name);
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.module).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
    });
    // The condition a CommonJS `require` resolves through. Absent here, absent in all six.
    expect(manifest.exports['.'].require).toBeUndefined();
  });

  test.each(RELEASE)('%s builds one format, and tsup is told so', (name) => {
    const tsup = readFileSync(join(ROOT, 'packages', name, 'tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/format: \['esm'\],/);
    expect(tsup).not.toMatch(/format: \[[^\]]*'cjs'/);
  });

  test.each(RELEASE)('%s has no CommonJS output on disk', (name) => {
    const dist = join(ROOT, 'packages', name, 'dist');
    if (!existsSync(dist)) return; // gitignored; nothing to say until something is built
    const built = readdirSync(dist);
    expect(built.filter((file) => file.endsWith('.cjs') || file.endsWith('.d.cts'))).toEqual([]);
    expect(built).toContain('index.js');
    expect(built).toContain('index.d.ts');
  });

  test.each(RELEASE)('%s states the format, and the exception, in its README', (name) => {
    const readme = readFileSync(join(ROOT, 'packages', name, 'README.md'), 'utf8');
    expect(readme).toContain('### Module format');
    expect(readme).toContain('ESM only, as every package in this release is.');
    // The split a consumer can still trip over has to be named where they will read it.
    for (const dual of DUAL) expect(readme).toContain(`@nostr-wot/${dual}`);
  });

  test('the dual packages are the two that were already published that way', () => {
    // A third dual package appearing in the stack is the asymmetry coming back, so it has to
    // fail here and be argued rather than merged quietly.
    const dual = readdirSync(join(ROOT, 'packages')).filter((name) => {
      const manifest = join(ROOT, 'packages', name, 'package.json');
      if (!existsSync(manifest)) return false;
      const { exports: entries, main } = JSON.parse(readFileSync(manifest, 'utf8'));
      const requires = JSON.stringify(entries ?? {}).includes('"require"');
      return requires || (typeof main === 'string' && main.endsWith('.cjs'));
    });
    expect(dual.filter((name) => (RELEASE as readonly string[]).includes(name))).toEqual([]);
    expect(dual).toEqual(expect.arrayContaining([...DUAL]));
  });
});
