// `dist/` freshness and integrity for the packages the app vendors by path, and for what
// `npm publish` uploads.
//
// One implementation for every package that has a `check:dist`. There were two: this script
// hashed build INPUTS only, while `packages/bunker/scripts/stamp-dist.mjs` hashed inputs AND
// outputs, so the bunker could detect a tampered or half-deleted `dist/` and its five
// neighbours could not. The doc comment here already said that a fix applied in one package
// and not its neighbour is how this class survives, which is what had happened. The stronger
// implementation won; the bunker's copy is gone.
//
// `stamp` writes `dist/.src-hash`, JSON:
//
//   { "inputs": <hash>, "outputs": <hash>, "tools": "tsup@x,esbuild@y,typescript@z" }
//
//   inputs  every file the build reads (`src/`, `tsup.config.ts`, `tsconfig.json`,
//           `package.json`), plus the TypeScript config as tsc resolves it (so
//           `../../tsconfig.base.json` counts) and the toolchain versions.
//   outputs every file the build wrote into `dist/`, the stamp itself excepted.
//
// `check` refuses when `dist/` is missing, unstamped, stamped from different inputs (stale),
// or no longer holds what the build produced (tampered, or partially copied or deleted).
//
// The stamp is written by each package's `build` script AFTER tsup exits, never from tsup's
// `onSuccess`: that hook runs concurrently with the declaration worker, so an outputs hash
// taken there would cover the previous `.d.ts` or none at all. `npm run dev` (tsup --watch)
// therefore leaves the stamp behind the tree, which reads as stale, which is honest: a watch
// build is not a verified build.
//
// `dist/` is gitignored, so the value of this is not that CI's fresh build is fresh. What it
// buys: `npm pack` and `npm publish` no longer rebuild (no `prepack`), so the bytes that go to
// npm are the bytes the gate verified, and `check:dist` is what says so. The negative side is
// proven in `packages/vault/test/dist-freshness.test.ts` (a fixture package, re-broken every
// way that matters) and in CI, which re-breaks the real `dist/` of every package in the list
// `packages` prints.
//
// The package is the working directory (npm run sets it) or an explicit path.
//
//   node scripts/dist-stamp.mjs stamp [package-dir]
//   node scripts/dist-stamp.mjs check [package-dir] [--dist DIR]
//   node scripts/dist-stamp.mjs packages
//
// `--dist DIR` checks another `dist` directory, a packed or vendored copy, against this tree's
// inputs. `packages` prints every workspace wired to this script, one path per line, so a CI
// loop cannot fall behind a package that was added.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** The repository root, one level up from this script. */
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * Everything a build reads from the package, in hash order. Not the whole story: every
 * package's tsconfig extends `../../tsconfig.base.json`, so the TypeScript config is also
 * hashed as tsc resolves it, and the compiler and bundler versions are hashed too. Hashing
 * `tsconfig.json` as a file let a base-config change pass on a stale dist; the bunker hit
 * that and fixed it, and a fix applied in one package and not its neighbour is how this
 * class survives.
 */
export const BUILD_INPUTS = ['src', 'tsup.config.ts', 'tsconfig.json', 'package.json'];

/** The tools whose version changes the output of a build from identical inputs. */
const TOOLS = ['tsup', 'esbuild', 'typescript'];

/** The stamp a build leaves in `dist/`. */
export const STAMP = '.src-hash';

/**
 * The TypeScript config of the package at `pkg` as tsc sees it, `extends` followed. A
 * package whose config cannot be resolved hashes as that failure, so a tsconfig that
 * appears, disappears or breaks is a different build too.
 */
export function resolvedTsConfig(pkg) {
  try {
    return execFileSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--showConfig', '-p', pkg], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return `<unresolvable>${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/** `tsup@x,esbuild@y,typescript@z`, as installed beside this script. */
export function toolVersions() {
  return TOOLS.map((name) => `${name}@${require(`${name}/package.json`).version}`).join(',');
}

/** What a build has to have produced for `dist/` to count as present. */
const OUTPUTS = ['index.js', 'index.d.ts'];

/**
 * Every file under `root`, relative path and bytes, in path order; a missing input is itself
 * hashed, so an input that appears or disappears is a different build. `skip` drops a file by
 * name, which is how the stamp keeps out of its own outputs hash.
 */
function hashPath(hash, root, skip = () => false) {
  if (!existsSync(root)) {
    hash.update('<absent>\0');
    return;
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else files.push(root);
  for (const file of files) {
    hash.update(file.slice(root.length).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
}

/** One hex hash over every build input of the package at `pkg`, the resolved tsconfig and the toolchain. */
export function hashBuildInputs(pkg, { tools = toolVersions() } = {}) {
  const hash = createHash('sha256');
  for (const input of BUILD_INPUTS) {
    hash.update(input + ':');
    hashPath(hash, join(pkg, input));
    hash.update('\n');
  }
  hash.update('tsconfig(resolved):' + resolvedTsConfig(pkg) + '\n');
  hash.update('tools:' + tools + '\n');
  return hash.digest('hex');
}

/**
 * One hex hash over every file a build left in `distDir`, the stamp excepted. This is the half
 * the five signer-stack packages did not have: without it a `dist/` can be edited or half
 * deleted after the build and still pass, which is exactly what a vendored copy or a published
 * tarball must not be able to do.
 */
export function hashOutputs(distDir) {
  const hash = createHash('sha256');
  hashPath(hash, distDir, (name) => name === STAMP);
  return hash.digest('hex');
}

/** Write `dist/.src-hash` for the package at `pkg`. Returns the stamp. */
export function stampDist(pkg, { distDir = join(pkg, 'dist') } = {}) {
  mkdirSync(distDir, { recursive: true });
  const stamp = { inputs: hashBuildInputs(pkg), outputs: hashOutputs(distDir), tools: toolVersions() };
  writeFileSync(join(distDir, STAMP), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

/**
 * Whether `distDir` is the build of the tree at `pkg`.
 *
 * Output first: a stamp with nothing beside it is the vacuous case, and it is refused before
 * any hash is compared. Then the inputs (is this the build of this source?) and then the
 * outputs (is this still what that build produced?).
 */
export function checkDist(pkg, { distDir = join(pkg, 'dist') } = {}) {
  for (const output of OUTPUTS) {
    if (!existsSync(join(distDir, output))) {
      return { ok: false, reason: 'missing', message: `no ${output} present in ${distDir}` };
    }
  }
  const stampFile = join(distDir, STAMP);
  if (!existsSync(stampFile)) {
    return { ok: false, reason: 'unstamped', message: `${distDir} carries no ${STAMP}; it was not built by this tree's build script` };
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable', message: `${distDir} has an unreadable ${STAMP}` };
  }
  if (typeof stamp?.inputs !== 'string' || typeof stamp?.outputs !== 'string') {
    return { ok: false, reason: 'unreadable', message: `${distDir} has a ${STAMP} without an inputs and an outputs hash` };
  }
  const inputs = hashBuildInputs(pkg);
  if (stamp.inputs !== inputs) {
    return { ok: false, reason: 'stale', message: `${distDir} is behind the source (inputs changed)` };
  }
  const outputs = hashOutputs(distDir);
  if (stamp.outputs !== outputs) {
    return { ok: false, reason: 'tampered', message: `${distDir} is not what the build produced (output edited, added or missing)` };
  }
  return { ok: true, inputs, outputs };
}

/**
 * Every workspace wired to this script, absolute paths in workspace order. Read from the root
 * `package.json` and each package's own `check:dist`, so the CI negative tests loop over
 * whatever is actually wired rather than a list somebody has to remember to extend.
 */
export function packagesWithCheckDist(root = ROOT) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  return workspaces
    .map((relative) => join(root, relative))
    .filter((dir) => {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) return false;
      const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.['check:dist'];
      return typeof script === 'string' && script.includes('dist-stamp.mjs');
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const distFlag = argv.indexOf('--dist');
  const distDir = distFlag === -1 ? undefined : resolve(argv[distFlag + 1] ?? '');
  const positional = argv.filter((arg, index) => (distFlag === -1 || (index !== distFlag && index !== distFlag + 1)) && !arg.startsWith('--'));
  const [command, dir] = positional;
  if (command === 'packages') {
    console.log(packagesWithCheckDist().join('\n'));
    process.exit(0);
  }
  const pkg = resolve(dir ?? process.cwd());
  const name = (() => {
    try {
      return JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).name ?? pkg;
    } catch {
      return pkg;
    }
  })();
  if (command === 'stamp') {
    stampDist(pkg, distDir ? { distDir } : {});
  } else if (command === 'check') {
    const result = checkDist(pkg, distDir ? { distDir } : {});
    if (!result.ok) {
      console.error(`check:dist: ${name}: ${result.message}; run \`npm run build -w ${name}\``);
      process.exit(1);
    }
    console.log(`check:dist: ${name}: dist/ matches the source and its stamp`);
  } else {
    console.error('usage: dist-stamp.mjs <stamp|check|packages> [package-dir] [--dist DIR]');
    process.exit(2);
  }
}
