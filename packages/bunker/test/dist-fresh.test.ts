import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = join(__dirname, "..");
const distDir = join(pkg, "dist");
const stamp = join(distDir, ".src-hash");

/** Hash of every file under src/, in path order: what `scripts/stamp-dist.mjs` writes at build time. */
export function hashSrc(root = join(pkg, "src")): string {
  const files: string[] = [];
  const walk = (dir: string) => {
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

describe("dist/ freshness", () => {
  it("dist/, when present, was built from the current src/ (anyone vendoring by path gets current code)", () => {
    if (!existsSync(distDir)) return; // nothing stale to vendor
    const built = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "<no stamp: built before stamping existed>";
    expect(built, `dist/ is behind src/: run \`npm run build -w @nostr-wot/bunker\` (or delete dist/)`).toBe(hashSrc());
  });
});
