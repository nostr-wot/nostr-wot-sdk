/**
 * `dist/` freshness and integrity, proven to fail before it is trusted.
 *
 * The shared packages are vendored by path into the app and published to npm without a
 * rebuild, so a `dist/` that is behind its source, or that was edited or half copied after the
 * build, ships as if it were the verified thing. Every build stamps `dist/.src-hash` with a
 * hash over its inputs (`src/`, `tsup.config.ts`, `tsconfig.json`, `package.json`, the
 * resolved TypeScript config, the toolchain) AND a hash over every file it wrote into `dist/`,
 * and `npm run check:dist` refuses when either does not match.
 *
 * The bunker's first attempt at this was vacuous in CI: `dist/` is gitignored, so a check
 * that only compared hashes passed with no `dist/` at all. So this suite does not check that
 * the real packages are fresh (a fresh build is what CI just made, which proves nothing). It
 * builds a fixture package in a temp dir and shows the check going red in each way that
 * matters: a stale build, a config-only edit, missing output, an edited output, a partial copy.
 * And it pins the wiring, so a package cannot drop out of the check without failing here.
 *
 * The one thing it does read from the real tree is a *copy* of each package's `dist/` when one
 * has been built, re-broken in the temp copy. That is skipped when there is no build, which is
 * why the fixture cases carry the weight.
 *
 * Lives beside `boundaries.test.ts` for the same reason it does: one guard over all of them.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_INPUTS,
  checkDist,
  hashBuildInputs,
  hashOutputs,
  packagesWithCheckDist,
  resolvedTsConfig,
  STAMP,
  stampDist,
  toolVersions,
} from '../../../scripts/dist-stamp.mjs';
import { declaredEntryPoints, releaseBlockers } from '../../../scripts/release-preflight.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'dist-stamp.mjs');
/**
 * Every package wired to the shared script, in workspace order. One list, because there is now
 * one implementation: the bunker's second copy of this machinery is gone, so the packages that
 * could not detect a tampered `dist/` now can.
 */
const WIRED = ['storage', 'permissions', 'accounts', 'vault', 'data', 'relay', 'signers', 'bunker', 'blossom', 'dm', 'wallet', 'ui', 'pq', 'signer-core'] as const;

/** The stamp a build left in a dist directory. */
const readStamp = (dir: string) => JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as { inputs: string; outputs: string; tools: string };

let pkg: string;

/** A package as tsup would leave it: inputs, and a built `dist/` with a stamp. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dist-freshness-'));
  mkdirSync(join(dir, 'src', 'inner'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'src', 'inner', 'two.ts'), 'export const two = 2;\n');
  writeFileSync(join(dir, 'tsup.config.ts'), "export default { entry: ['src/index.ts'] };\n");
  // Extends a base outside the package, as every real package extends ../../tsconfig.base.json.
  mkdirSync(join(dir, 'base'));
  writeFileSync(join(dir, 'base', 'tsconfig.base.json'), '{ "compilerOptions": { "strict": true, "target": "es2022" } }\n');
  writeFileSync(join(dir, 'tsconfig.json'), '{ "extends": "./base/tsconfig.base.json", "compilerOptions": { "outDir": "dist" } }\n');
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture", "version": "1.0.0" }\n');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const one: 1;\n');
  stampDist(dir);
  return dir;
}

beforeEach(() => {
  pkg = fixture();
});
afterEach(() => {
  rmSync(pkg, { recursive: true, force: true });
});

const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('the check can fail', () => {
  test('a fresh build passes, and the stamp holds the hash of the inputs and of the outputs', () => {
    const dist = join(pkg, 'dist');
    expect(checkDist(pkg)).toEqual({ ok: true, inputs: hashBuildInputs(pkg), outputs: hashOutputs(dist) });
    expect(readStamp(dist)).toEqual({ inputs: hashBuildInputs(pkg), outputs: hashOutputs(dist), tools: toolVersions() });
    expect(hashBuildInputs(pkg)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOutputs(dist)).toMatch(/^[0-9a-f]{64}$/);
    // The stamp is not part of what it stamps, or no stamp could ever be written.
    expect(hashOutputs(dist)).toBe(hashOutputs(dist));
  });

  test('a stale build fails: the source moved after the build', () => {
    writeFileSync(join(pkg, 'src', 'inner', 'two.ts'), 'export const two = 3;\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'stale' });
    // Rebuilding (re-stamping) makes it current again; the check is about the stamp, not time.
    stampDist(pkg);
    expect(checkDist(pkg)).toMatchObject({ ok: true });
  });

  test.each(['tsup.config.ts', 'tsconfig.json', 'package.json'])('a config-only edit fails: %s changed after the build', (file) => {
    writeFileSync(join(pkg, file), readFileSync(join(pkg, file), 'utf8') + '\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'stale' });
  });

  test('missing output fails, with or without a stamp', () => {
    rmSync(join(pkg, 'dist'), { recursive: true });
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
    // A stamp alone is not a build. This is the vacuous case: dist/ absent, hashes "matching".
    mkdirSync(join(pkg, 'dist'));
    writeFileSync(join(pkg, 'dist', STAMP), JSON.stringify({ inputs: hashBuildInputs(pkg), outputs: hashOutputs(join(pkg, 'dist')), tools: toolVersions() }));
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
    // And a build without its types is not a build either.
    writeFileSync(join(pkg, 'dist', 'index.js'), '');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
  });

  test('a build with no stamp fails: it predates the check, or was made some other way', () => {
    rmSync(join(pkg, 'dist', STAMP));
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'unstamped' });
  });

  test('a file added, removed or renamed under src/ changes the hash', () => {
    const before = hashBuildInputs(pkg);
    writeFileSync(join(pkg, 'src', 'three.ts'), 'export const three = 3;\n');
    const added = hashBuildInputs(pkg);
    expect(added).not.toBe(before);
    renameSync(join(pkg, 'src', 'three.ts'), join(pkg, 'src', 'tres.ts'));
    expect(hashBuildInputs(pkg)).not.toBe(added);
    rmSync(join(pkg, 'src', 'tres.ts'));
    expect(hashBuildInputs(pkg)).toBe(before);
  });

  test('a change to the base config the package extends fails, though no file in the package changed', () => {
    // The bunker's fourteenth verification failure: tsconfig.json was hashed as a file, so
    // an edit to ../../tsconfig.base.json passed on a stale dist. The config is hashed as
    // tsc resolves it, `extends` followed, so the base counts.
    writeFileSync(join(pkg, 'base', 'tsconfig.base.json'), '{ "compilerOptions": { "strict": false, "target": "es2022" } }\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'stale' });
    expect(resolvedTsConfig(pkg)).toContain('"strict": false');
  });

  test('the toolchain is part of the hash: tsup, esbuild and typescript versions', () => {
    expect(toolVersions()).toMatch(/^tsup@\d+\.\d+\.\d+,esbuild@\d+\.\d+\.\d+,typescript@\d+\.\d+\.\d+$/);
    const stamped = readStamp(join(pkg, 'dist'));
    expect(stamped.tools).toBe(toolVersions());
    expect(hashBuildInputs(pkg, { tools: 'tsup@0.0.0,esbuild@0.0.0,typescript@0.0.0' })).not.toBe(stamped.inputs);
  });

  test('a build input that disappears or appears changes the hash', () => {
    const before = hashBuildInputs(pkg);
    rmSync(join(pkg, 'tsconfig.json'));
    expect(hashBuildInputs(pkg)).not.toBe(before);
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'stale' });
  });

  test('the command itself exits non-zero on every failure and zero on success, naming the package', () => {
    expect(cli('check', pkg)).toMatchObject({ status: 0 });
    writeFileSync(join(pkg, 'src', 'index.ts'), 'export const one = 2;\n');
    const stale = cli('check', pkg);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/behind the source/i);
    rmSync(join(pkg, 'dist'), { recursive: true });
    const missing = cli('check', pkg);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no index\.js present/i);
    expect(cli('stamp', pkg)).toMatchObject({ status: 0 });
    expect(existsSync(join(pkg, 'dist', '.src-hash'))).toBe(true);
    // A stamp does not manufacture a build.
    expect(cli('check', pkg).status).toBe(1);
    expect(cli('nonsense', pkg).status).not.toBe(0);
  });
});

describe('the check catches a dist/ that is not what the build produced', () => {
  // The half the five signer-stack packages were missing: their stamp covered build inputs
  // only, so anything could happen to dist/ after the build and the check still passed. Only
  // the bunker hashed its outputs, and only the bunker's dist was proven against tampering.

  test('an edited output fails: the inputs still match, the outputs do not', () => {
    writeFileSync(join(pkg, 'dist', 'index.js'), readFileSync(join(pkg, 'dist', 'index.js'), 'utf8') + 'globalThis.x = 1;\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'tampered' });
    expect(hashBuildInputs(pkg)).toBe(readStamp(join(pkg, 'dist')).inputs);
  });

  test('a deleted output fails even while index.js and index.d.ts are both present', () => {
    writeFileSync(join(pkg, 'dist', 'index.js.map'), '{"version":3}\n');
    stampDist(pkg);
    expect(checkDist(pkg)).toMatchObject({ ok: true });
    rmSync(join(pkg, 'dist', 'index.js.map'));
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'tampered' });
  });

  test('a file added to dist/ fails: a published dist carries what the build wrote and nothing else', () => {
    writeFileSync(join(pkg, 'dist', 'extra.js'), 'export const smuggled = true;\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'tampered' });
  });

  test('a renamed output fails, though the set of bytes is unchanged', () => {
    renameSync(join(pkg, 'dist', 'index.d.ts'), join(pkg, 'dist', 'index.d.mts'));
    // Refused as missing first: index.d.ts is required output, not merely hashed.
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
    writeFileSync(join(pkg, 'dist', 'index.d.ts'), 'export declare const one: 1;\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'tampered' });
  });

  test('a stamp that is not the JSON this build writes fails as unreadable, never as ok', () => {
    writeFileSync(join(pkg, 'dist', STAMP), 'not json\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'unreadable' });
    // The old bare-hex stamp the five packages used to write is exactly this case, so a dist
    // built before the two implementations were unified cannot pass either.
    writeFileSync(join(pkg, 'dist', STAMP), hashBuildInputs(pkg) + '\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  test('--dist checks a copy against this tree: a good copy passes, a tampered and a partial copy fail', () => {
    const copies = mkdtempSync(join(tmpdir(), 'dist-copy-'));
    const good = join(copies, 'good');
    cpSync(join(pkg, 'dist'), good, { recursive: true });
    expect(checkDist(pkg, { distDir: good })).toMatchObject({ ok: true });
    expect(cli('check', pkg, '--dist', good)).toMatchObject({ status: 0 });

    const tampered = join(copies, 'tampered');
    cpSync(join(pkg, 'dist'), tampered, { recursive: true });
    writeFileSync(join(tampered, 'index.js'), 'export const one = 666;\n');
    expect(checkDist(pkg, { distDir: tampered })).toMatchObject({ ok: false, reason: 'tampered' });
    const tamperedCli = cli('check', pkg, '--dist', tampered);
    expect(tamperedCli.status).toBe(1);
    expect(tamperedCli.stderr).toMatch(/not what the build produced/i);

    const partial = join(copies, 'partial');
    cpSync(join(pkg, 'dist'), partial, { recursive: true });
    rmSync(join(partial, 'index.d.ts'));
    expect(checkDist(pkg, { distDir: partial })).toMatchObject({ ok: false, reason: 'missing' });
    expect(cli('check', pkg, '--dist', partial).status).toBe(1);

    // And the copy is judged against this tree, not against itself: a copy of a stale build
    // fails even though the copy is byte for byte what was stamped.
    writeFileSync(join(pkg, 'src', 'index.ts'), 'export const one = 2;\n');
    expect(checkDist(pkg, { distDir: good })).toMatchObject({ ok: false, reason: 'stale' });
    rmSync(copies, { recursive: true, force: true });
  });
});

describe('every package with a check is wired to the one implementation', () => {
  test('the wired packages are exactly the workspaces that declare a check', () => {
    // Read from the workspaces and their own scripts, not from a list somebody maintains, so
    // the CI negative tests (which loop over `dist-stamp.mjs packages`) cannot fall behind a
    // package that was added.
    expect(packagesWithCheckDist(ROOT)).toEqual(WIRED.map((name) => join(ROOT, 'packages', name)));
  });

  test.each(WIRED)('%s stamps after tsup exits and checks with the shared script', (name) => {
    const dir = join(ROOT, 'packages', name);
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts as Record<string, string>;
    const build = name === 'ui' ? 'tsup && cp src/styles.css dist/styles.css' : 'tsup';
    expect(scripts['build']).toBe(`${build} && node ../../scripts/dist-stamp.mjs stamp`);
    expect(scripts['check:dist']).toBe('node ../../scripts/dist-stamp.mjs check');
    // Not from tsup's onSuccess, which runs concurrently with the declaration worker: the
    // outputs hash taken there covers the previous `.d.ts` or none. The stamp is a separate
    // process after tsup has exited, which is what the bunker worked out and the other five
    // never got.
    const tsup = readFileSync(join(dir, 'tsup.config.ts'), 'utf8');
    expect(tsup).not.toMatch(/^\s*onSuccess/m);
    expect(tsup).not.toContain('stampDist');
    for (const input of BUILD_INPUTS) expect(existsSync(join(dir, input))).toBe(true);
  });

  test('no package carries a second copy of the stamp machinery', () => {
    // Two implementations of one stamp is how the bunker ended up with a guard its neighbours
    // did not have. There is one script, at the root.
    for (const name of WIRED) {
      expect(existsSync(join(ROOT, 'packages', name, 'scripts', 'stamp-dist.mjs'))).toBe(false);
      expect(existsSync(join(ROOT, 'packages', name, 'scripts', 'check-dist.mjs'))).toBe(false);
    }
  });

  test('no workspace rebuilds itself during pack or publish', () => {
    // `prepack: npm run build` was set on the six unpublished packages, so `changeset publish`
    // rebuilt and re-stamped every dist/ during the publish, after CI had built it and
    // check:dist had verified it: npm got a build no gate had seen. A `prepublishOnly` doing
    // the same was already dropped for the sharper version of it, where the rebuilds raced
    // through a shared dist/ and left @nostr-wot/dm unpublished twice. What publishes is now
    // what was verified, which is only true while nothing regenerates dist/ late.
    const workspaces = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces as string[];
    for (const relative of workspaces) {
      const scripts = (JSON.parse(readFileSync(join(ROOT, relative, 'package.json'), 'utf8')).scripts ?? {}) as Record<string, string>;
      for (const hook of ['prepack', 'prepublishOnly', 'prepublish', 'prepare']) {
        expect({ [relative]: scripts[hook] }).toEqual({ [relative]: undefined });
      }
    }
  });

  test('the release gate verifies the build instead of making a new one', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['release']).toBe('node scripts/release-preflight.mjs && changeset publish');
  });

  test('the root check runs every workspace that has one', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['check:dist']).toBe('npm run check:dist -ws --if-present');
  });

  test('the inputs are what a build reads', () => {
    expect(BUILD_INPUTS).toEqual(['src', 'tsup.config.ts', 'tsconfig.json', 'package.json']);
  });
});

describe('the release preflight', () => {
  // `npm run release` runs this before `changeset publish`. It is the guarantee that replaced
  // `prepack`: a publish from a tree with no build, or with a dist/ that is not the one the
  // gate verified, stops here instead of uploading an empty or unverified package.

  /** A workspace root: one package wired to the shared check, one plain published package. */
  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'preflight-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/stamped', 'packages/plain'] }));
    const stamped = join(root, 'packages', 'stamped');
    mkdirSync(join(stamped, 'src'), { recursive: true });
    writeFileSync(join(stamped, 'src', 'index.ts'), 'export const one = 1;\n');
    writeFileSync(join(stamped, 'tsup.config.ts'), "export default { entry: ['src/index.ts'] };\n");
    writeFileSync(join(stamped, 'tsconfig.json'), '{ "compilerOptions": { "outDir": "dist" } }\n');
    writeFileSync(
      join(stamped, 'package.json'),
      JSON.stringify({
        name: '@fixture/stamped',
        version: '1.0.0',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        scripts: { 'check:dist': 'node ../../scripts/dist-stamp.mjs check' },
      }),
    );
    mkdirSync(join(stamped, 'dist'));
    writeFileSync(join(stamped, 'dist', 'index.js'), 'export const one = 1;\n');
    writeFileSync(join(stamped, 'dist', 'index.d.ts'), 'export declare const one: 1;\n');
    stampDist(stamped);
    const plain = join(root, 'packages', 'plain');
    mkdirSync(join(plain, 'dist'), { recursive: true });
    writeFileSync(join(plain, 'dist', 'index.js'), 'export const two = 2;\n');
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: '@fixture/plain', version: '1.0.0', exports: { '.': { import: './dist/index.js' } } }),
    );
    return root;
  }

  let root: string;
  beforeEach(() => {
    root = fixtureRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const preflight = (dir: string) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-preflight.mjs'), dir], { encoding: 'utf8' });

  test('a tree whose packages are all built and stamped passes', () => {
    expect(releaseBlockers(root)).toEqual([]);
    expect(preflight(root)).toMatchObject({ status: 0 });
  });

  test('a publish from a clean checkout is refused: the dist the package promises is not there', () => {
    // The case that makes removing `prepack` safe to do. Without this, nothing rebuilds and
    // nothing complains, and npm gets a package whose tarball holds no code at all.
    rmSync(join(root, 'packages', 'stamped', 'dist'), { recursive: true });
    rmSync(join(root, 'packages', 'plain', 'dist'), { recursive: true });
    expect(releaseBlockers(root)).toEqual([
      expect.stringContaining('@fixture/stamped: no index.js present'),
      expect.stringContaining('@fixture/stamped: promises ./dist/index.js'),
      expect.stringContaining('@fixture/stamped: promises ./dist/index.d.ts'),
      expect.stringContaining('@fixture/plain: promises ./dist/index.js'),
    ]);
    const run = preflight(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/must not be published/i);
  });

  test('a package with no stamp is still held to the entry points it promises', () => {
    // @fixture/plain has no check:dist, as several published workspaces have none. The weaker
    // guarantee is that it cannot publish a tarball missing the file its exports name.
    rmSync(join(root, 'packages', 'plain', 'dist', 'index.js'));
    expect(releaseBlockers(root)).toEqual(['@fixture/plain: promises ./dist/index.js and has not built it; run `npm run build`']);
    expect(preflight(root).status).toBe(1);
  });

  test('a stale dist is refused even though every promised file is present', () => {
    writeFileSync(join(root, 'packages', 'stamped', 'src', 'index.ts'), 'export const one = 2;\n');
    expect(releaseBlockers(root)).toEqual([expect.stringContaining('(stale)')]);
    expect(preflight(root).status).toBe(1);
  });

  test('a tampered dist is refused: the files are all there and are not what was built', () => {
    writeFileSync(join(root, 'packages', 'stamped', 'dist', 'index.js'), 'export const one = 666;\n');
    expect(releaseBlockers(root)).toEqual([expect.stringContaining('(tampered)')]);
    expect(preflight(root).status).toBe(1);
  });

  test('a private workspace is not held to entry points it never publishes', () => {
    const manifest = join(root, 'packages', 'plain', 'package.json');
    const plain = JSON.parse(readFileSync(manifest, 'utf8'));
    rmSync(join(root, 'packages', 'plain', 'dist', 'index.js'));
    writeFileSync(manifest, JSON.stringify({ ...plain, private: true }));
    expect(releaseBlockers(root)).toEqual([]);
  });

  test('every entry point a manifest promises is collected, wildcards excepted', () => {
    expect(
      declaredEntryPoints({
        main: './dist/index.cjs',
        module: './dist/index.js',
        types: './dist/index.d.ts',
        bin: { tool: './dist/cli.js' },
        exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' }, './styles.css': './dist/styles.css', './*': './dist/*.js' },
      }),
    ).toEqual(['./dist/index.cjs', './dist/index.js', './dist/index.d.ts', './dist/cli.js', './dist/styles.css']);
  });
});

describe('a real built dist/, re-broken in a copy', () => {
  // The fixture cases above carry the weight, because `dist/` is gitignored and a local run may
  // have no build at all. When there is one (CI builds before it tests), each package's real
  // output is copied to a temp dir and broken there, which is the vendored-tarball case.
  test.each(WIRED)('%s: a copy passes, the same copy tampered or partial does not', (name) => {
    const dir = join(ROOT, 'packages', name);
    // No current build here (gitignored dist/, or a tree edited since the last build): then the
    // only thing to assert is that the check says so rather than passing vacuously.
    if (!checkDist(dir).ok) {
      expect(checkDist(dir)).toMatchObject({ ok: false });
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), `dist-copy-${name}-`));
    try {
      const copy = join(tmp, 'dist');
      cpSync(join(dir, 'dist'), copy, { recursive: true });
      expect(checkDist(dir, { distDir: copy })).toMatchObject({ ok: true });
      writeFileSync(join(copy, 'index.js'), readFileSync(join(copy, 'index.js'), 'utf8') + '\nglobalThis.tampered = true;\n');
      expect(checkDist(dir, { distDir: copy })).toMatchObject({ ok: false, reason: 'tampered' });
      cpSync(join(dir, 'dist'), copy, { recursive: true, force: true });
      rmSync(join(copy, 'index.d.ts'));
      expect(checkDist(dir, { distDir: copy })).toMatchObject({ ok: false, reason: 'missing' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
