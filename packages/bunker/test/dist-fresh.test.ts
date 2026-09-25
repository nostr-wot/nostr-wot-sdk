import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The same function the build stamps with, so the test and the stamp cannot drift apart.
// @ts-expect-error plain ESM script without a declaration file
import { hashSrc } from "../scripts/stamp-dist.mjs";

const pkg = join(__dirname, "..");
const distDir = join(pkg, "dist");
const stamp = join(distDir, ".src-hash");

describe("dist/ freshness", () => {
  it("dist/, when present, was built from the current src/ (anyone vendoring by path gets current code)", () => {
    if (!existsSync(distDir)) return; // nothing stale to vendor
    const built = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "<no stamp: built before stamping existed>";
    expect(built, `dist/ is behind src/: run \`npm run build -w @nostr-wot/bunker\` (or delete dist/)`).toBe(hashSrc());
  });
});
