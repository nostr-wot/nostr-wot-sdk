// `dist/` freshness for the packages the app vendors by path.
//
// tsup's `onSuccess` runs `stamp` after every build: it writes `dist/.src-hash`, one hash over
// everything the build read (`src/`, `tsup.config.ts`, `tsconfig.json`, `package.json`).
// `check` recomputes that hash from the tree and refuses when `dist/` is missing, unstamped,
// or stamped from different inputs. `npm pack` rebuilds first (`prepack`); vendoring by path
// runs `npm run check:dist` and stops on red. `dist/` is gitignored, so the check is not that
// CI's fresh build is fresh: `packages/vault/test/dist-freshness.test.ts` shows it going red
// on a stale build, a config-only edit and missing output, which is the property that matters.
//
// One script for every package: the package is the working directory (tsup and npm run both
// set it) or an explicit path.
//
//   node scripts/dist-stamp.mjs stamp [package-dir]
//   node scripts/dist-stamp.mjs check [package-dir]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything a build reads, in hash order. A change to any of these is a different build. */
export const BUILD_INPUTS = ['src', 'tsup.config.ts', 'tsconfig.json', 'package.json'];

/** What a build has to have produced for `dist/` to count as present. */
const OUTPUTS = ['index.js', 'index.d.ts'];

/** Every file under `root`, relative path and bytes, in path order; a missing input is itself hashed. */
function hashPath(hash, root) {
  if (!existsSync(root)) {
    hash.update('<absent>\0');
    return;
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
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

/** One hex hash over every build input of the package at `pkg`. */
export function hashBuildInputs(pkg) {
  const hash = createHash('sha256');
  for (const input of BUILD_INPUTS) {
    hash.update(input + ':');
    hashPath(hash, join(pkg, input));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Write `dist/.src-hash` for the package at `pkg`. Returns the hash. */
export function stampDist(pkg) {
  const hash = hashBuildInputs(pkg);
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', '.src-hash'), hash + '\n');
  return hash;
}

/**
 * Whether `dist/` at `pkg` is the build of the tree at `pkg`.
 *
 * Output first: a stamp with nothing beside it is the vacuous case, and it is refused before
 * the hash is even compared.
 */
export function checkDist(pkg) {
  for (const output of OUTPUTS) {
    if (!existsSync(join(pkg, 'dist', output))) {
      return { ok: false, reason: 'missing', message: `no dist/${output} present` };
    }
  }
  const stampFile = join(pkg, 'dist', '.src-hash');
  if (!existsSync(stampFile)) {
    return { ok: false, reason: 'unstamped', message: 'dist/ carries no .src-hash; it was not built by this tree\'s tsup' };
  }
  const built = readFileSync(stampFile, 'utf8').trim();
  const current = hashBuildInputs(pkg);
  if (built !== current) {
    return { ok: false, reason: 'stale', message: 'dist/ is behind the source' };
  }
  return { ok: true, hash: current };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  const pkg = resolve(dir ?? process.cwd());
  const name = (() => {
    try {
      return JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).name ?? pkg;
    } catch {
      return pkg;
    }
  })();
  if (command === 'stamp') {
    stampDist(pkg);
  } else if (command === 'check') {
    const result = checkDist(pkg);
    if (!result.ok) {
      console.error(`check:dist: ${name}: ${result.message}; run \`npm run build -w ${name}\``);
      process.exit(1);
    }
    console.log(`check:dist: ${name}: dist/ matches the source`);
  } else {
    console.error('usage: dist-stamp.mjs <stamp|check> [package-dir]');
    process.exit(2);
  }
}
