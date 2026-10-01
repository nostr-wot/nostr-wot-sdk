// The last thing that runs before `changeset publish`, and the reason no package rebuilds
// itself during the publish any more.
//
// What `npm publish` uploads is whatever `dist/` holds at the moment it runs. Every package
// used to carry `prepack: npm run build`, so `changeset publish` rebuilt and re-stamped each
// `dist/` during the publish itself, right after CI had built it and `check:dist` had verified
// it: the bytes that reached npm were from a build no gate ever saw. (A `prepublishOnly` hook
// doing the same thing was dropped earlier, for a sharper version of the same problem: the
// rebuilds raced each other through a shared `dist/` and left `@nostr-wot/dm` unpublished
// twice.) Removing `prepack` means nothing regenerates `dist/` late, which only helps if
// something guarantees `dist/` is there and current when the publish starts. That is this
// script:
//
//   1. every package with a `check:dist` is checked, in process: `dist/` present, built from
//      this exact tree, and still holding exactly what that build produced;
//   2. every publishable workspace has, on disk, every file its own `main`, `module`, `types`,
//      `bin` and `exports` promise. A package with no stamp (no `check:dist`) at least cannot
//      publish an empty tarball, which is what a publish from a clean checkout would do.
//
// Red here stops the publish. `npm run release` is `node scripts/release-preflight.mjs &&
// changeset publish`, and `release.yml` builds, re-checks, type checks and tests before it
// calls that, so the preflight is a second reading of a tree nothing has touched since.
//
//   node scripts/release-preflight.mjs [root]
//
// `root` (default: the repository above this script) is there so the suite can run it against a
// fixture tree; see `packages/vault/test/dist-freshness.test.ts`.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDist, packagesWithCheckDist } from './dist-stamp.mjs';

/** Every string leaf of an `exports` tree, conditions and subpaths alike. */
function exportTargets(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) exportTargets(item, out);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) exportTargets(value, out);
  return out;
}

/**
 * Every file a package promises a consumer, relative to the package. Wildcard subpaths are
 * skipped: `./*` names a pattern, not a file.
 */
export function declaredEntryPoints(manifest) {
  const targets = [
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.typings,
    typeof manifest.browser === 'string' ? manifest.browser : undefined,
    ...(typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})),
    ...exportTargets(manifest.exports),
  ];
  return [...new Set(targets.filter((target) => typeof target === 'string' && target.startsWith('.') && !target.includes('*')))];
}

/** Every workspace `changeset publish` could publish: a workspace that is not private. */
function publishableWorkspaces(root) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  return workspaces
    .map((relative) => join(root, relative))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => manifest.private !== true);
}

/** Every reason this tree must not be published, in reading order. Empty means go ahead. */
export function releaseBlockers(root) {
  const blockers = [];
  for (const pkg of packagesWithCheckDist(root)) {
    const result = checkDist(pkg);
    if (!result.ok) {
      const name = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).name;
      blockers.push(`${name}: ${result.message} (${result.reason}); run \`npm run build\``);
    }
  }
  for (const { dir, manifest } of publishableWorkspaces(root)) {
    for (const entry of declaredEntryPoints(manifest)) {
      if (!existsSync(join(dir, entry))) {
        blockers.push(`${manifest.name}: promises ${entry} and has not built it; run \`npm run build\``);
      }
    }
  }
  return blockers;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const blockers = releaseBlockers(root);
  if (blockers.length > 0) {
    console.error('release preflight: this tree must not be published:');
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }
  console.log('release preflight: every package has the dist it was verified with, and every entry point it promises');
}
