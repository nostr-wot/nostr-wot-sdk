/**
 * `dist/` freshness, proven to fail before it is trusted.
 *
 * The shared packages are vendored by path into the app, so a `dist/` that is behind its
 * source ships stale code with a current version number. Every build stamps `dist/.src-hash`
 * with a hash over its inputs (`src/`, `tsup.config.ts`, `tsconfig.json`, `package.json`),
 * and `npm run check:dist` refuses when the stamp is missing or does not match the tree.
 *
 * The bunker's first attempt at this was vacuous in CI: `dist/` is gitignored, so a check
 * that only compared hashes passed with no `dist/` at all. So this suite does not check that
 * the real packages are fresh (a fresh build is what CI just made, which proves nothing). It
 * builds a fixture package in a temp dir and shows the check going red in each way that
 * matters: a stale build, a config-only edit, missing output. And it pins the wiring, so a
 * shared package cannot drop out of the check without failing here.
 *
 * Lives beside `boundaries.test.ts` for the same reason it does: one guard over all five.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_INPUTS, checkDist, hashBuildInputs, stampDist } from '../../../scripts/dist-stamp.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'dist-stamp.mjs');
const SHARED = ['storage', 'vault', 'accounts', 'permissions', 'signer-core'] as const;

let pkg: string;

/** A package as tsup would leave it: inputs, and a built `dist/` with a stamp. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dist-freshness-'));
  mkdirSync(join(dir, 'src', 'inner'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'src', 'inner', 'two.ts'), 'export const two = 2;\n');
  writeFileSync(join(dir, 'tsup.config.ts'), "export default { entry: ['src/index.ts'] };\n");
  writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
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
  test('a fresh build passes, and the stamp is the hash of the inputs', () => {
    expect(checkDist(pkg)).toEqual({ ok: true, hash: hashBuildInputs(pkg) });
    expect(readFileSync(join(pkg, 'dist', '.src-hash'), 'utf8').trim()).toBe(hashBuildInputs(pkg));
    expect(hashBuildInputs(pkg)).toMatch(/^[0-9a-f]{64}$/);
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
    // A stamp alone is not a build. This is the vacuous case: dist/ absent, hash "matching".
    mkdirSync(join(pkg, 'dist'));
    writeFileSync(join(pkg, 'dist', '.src-hash'), hashBuildInputs(pkg) + '\n');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
    // And a build without its types is not a build either.
    writeFileSync(join(pkg, 'dist', 'index.js'), '');
    expect(checkDist(pkg)).toMatchObject({ ok: false, reason: 'missing' });
  });

  test('a build with no stamp fails: it predates the check, or was made some other way', () => {
    rmSync(join(pkg, 'dist', '.src-hash'));
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
    expect(missing.stderr).toMatch(/no dist/i);
    expect(cli('stamp', pkg)).toMatchObject({ status: 0 });
    expect(existsSync(join(pkg, 'dist', '.src-hash'))).toBe(true);
    // A stamp does not manufacture a build.
    expect(cli('check', pkg).status).toBe(1);
    expect(cli('nonsense', pkg).status).not.toBe(0);
  });
});

describe('every shared package is wired', () => {
  test.each(SHARED)('%s stamps on build, exposes check:dist, and rebuilds before pack', (name) => {
    const dir = join(ROOT, 'packages', name);
    const tsup = readFileSync(join(dir, 'tsup.config.ts'), 'utf8');
    // The function form, not a shell string: tsup 8.5 runs a string `onSuccess` through
    // tinyexec, which mangles any `../` token, so `node ../../scripts/... stamp` exited 127
    // in every package and never stamped anything. The function runs in-process, and a
    // throw in it fails the build.
    expect(tsup).toContain("import { stampDist } from '../../scripts/dist-stamp.mjs';");
    expect(tsup).toMatch(/onSuccess: async \(\) => \{\s*stampDist\(process\.cwd\(\)\);\s*\}/);
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['check:dist']).toBe('node ../../scripts/dist-stamp.mjs check');
    expect(scripts['prepack']).toBe('npm run build');
    for (const input of BUILD_INPUTS) expect(existsSync(join(dir, input))).toBe(true);
  });

  test('the root check runs every workspace that has one', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['check:dist']).toBe('npm run check:dist -ws --if-present');
  });

  test('the inputs are what a build reads', () => {
    expect(BUILD_INPUTS).toEqual(['src', 'tsup.config.ts', 'tsconfig.json', 'package.json']);
  });
});
