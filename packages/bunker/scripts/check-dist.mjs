// Fails when dist/ is missing or was built from different inputs than the
// tree holds now. Run it before vendoring this package by path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashBuildInputs } from "./stamp-dist.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = join(pkg, "dist", ".src-hash");
if (!existsSync(join(pkg, "dist", "index.js"))) {
  console.error("check:dist: no dist/ build present; run `npm run build -w @nostr-wot/bunker`");
  process.exit(1);
}
const built = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
const current = hashBuildInputs();
if (built !== current) {
  console.error("check:dist: dist/ is behind the source; run `npm run build -w @nostr-wot/bunker`");
  process.exit(1);
}
console.log("check:dist: dist/ matches the source");
