// Run by tsup's onSuccess: writes dist/.src-hash, a hash of everything the
// build depends on (src/, tsup.config.ts, tsconfig.json, package.json), so
// `npm run check:dist` can tell a stale dist/ from a current one before it is
// vendored. `npm pack` rebuilds first (prepack); vendoring by path should run
// the check.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Hash of every file under `root`, in path order. */
export const BUILD_INPUTS = ["src", "tsup.config.ts", "tsconfig.json", "package.json"];

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
  return h.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist", ".src-hash"), hashBuildInputs() + "\n");
}
