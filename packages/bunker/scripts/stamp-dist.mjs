// Run by tsup's onSuccess: writes dist/.src-hash, a JSON stamp with a hash of
// everything the build depends on (src/, tsup.config.ts, package.json, the
// RESOLVED TypeScript config via tsc --showConfig so ../../tsconfig.base.json
// counts, and the tsup/esbuild/typescript versions) AND a hash of everything
// the build produced. `npm run check:dist` compares both, so a stale, tampered
// or partially deleted dist/ fails. CI runs it after the build, proves it bites
// on a tampered copy, and checks the packed tarball; vendoring by path should
// run it too.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Hash of every file under `root`, in path order. */
export const BUILD_INPUTS = ["src", "tsup.config.ts", "package.json"];
const require = createRequire(import.meta.url);

/** The TypeScript config as tsc sees it, `extends` resolved. */
export function resolvedTsConfig() {
  return execFileSync(process.execPath, [require.resolve("typescript/lib/tsc.js"), "--showConfig", "-p", pkg], { encoding: "utf8" });
}

export function toolVersions() {
  return ["tsup", "esbuild", "typescript"].map((name) => `${name}@${require(`${name}/package.json`).version}`).join(",");
}

export function hashSrc(root = join(pkg, "src"), skip = () => false) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (skip(name)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else files.push(root);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.slice(root.length));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

/** One hash over every build input, in order. */
export function hashBuildInputs() {
  const h = createHash("sha256");
  for (const input of BUILD_INPUTS) h.update(input + ":" + hashSrc(join(pkg, input)) + "\n");
  h.update("tsconfig(resolved):" + resolvedTsConfig() + "\n");
  h.update("tools:" + toolVersions() + "\n");
  return h.digest("hex");
}

export const STAMP = ".src-hash";

/** Hash of every file in a dist directory except the stamp itself. */
export function hashOutputs(distDir = join(pkg, "dist")) {
  return hashSrc(distDir, (name) => name === STAMP);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const stamp = { inputs: hashBuildInputs(), outputs: hashOutputs(), tools: toolVersions() };
  writeFileSync(join(pkg, "dist", STAMP), JSON.stringify(stamp, null, 2) + "\n");
}
