// Run by tsup's onSuccess: writes dist/.src-hash, a hash of everything the
// build depends on: src/, tsup.config.ts, package.json, the RESOLVED TypeScript
// config (tsc --showConfig, so a change in ../../tsconfig.base.json counts),
// and the versions of tsup, esbuild and typescript. `npm run check:dist`
// compares; CI runs it after the build, and so should anyone vendoring by path.
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

export function hashSrc(root = join(pkg, "src")) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist", ".src-hash"), hashBuildInputs() + "\n");
}
