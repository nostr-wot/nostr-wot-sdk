// Writes dist/.src-hash after a build so test/dist-fresh.test.ts can tell a
// stale dist/ from a current one. Anyone vendoring this package by path gets
// the code the stamp says they get, or a failing test.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Hash of every file under `root`, in path order. */
export function hashSrc(root = join(pkg, "src")) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.slice(root.length));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist", ".src-hash"), hashSrc() + "\n");
}
