// Fails when a dist/ is missing, was built from different inputs than the
// tree holds now, or no longer contains what the build produced (tampered or
// partially deleted). `--dist DIR` checks another dist directory (a packed or
// vendored copy) against this tree's inputs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashBuildInputs, hashOutputs, STAMP } from "./stamp-dist.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const distDir = args.includes("--dist") ? args[args.indexOf("--dist") + 1] : join(pkg, "dist");
const fail = (message) => {
  console.error(`check:dist: ${message}`);
  process.exit(1);
};

if (!existsSync(join(distDir, "index.js"))) fail(`no build present in ${distDir}; run \`npm run build -w @nostr-wot/bunker\``);
if (!existsSync(join(distDir, STAMP))) fail(`${distDir} has no stamp; it was not produced by \`npm run build\``);
let stamp;
try {
  stamp = JSON.parse(readFileSync(join(distDir, STAMP), "utf8"));
} catch {
  fail(`${distDir} has an unreadable stamp`);
}
if (stamp.inputs !== hashBuildInputs()) fail(`${distDir} is behind the source (inputs changed); run \`npm run build -w @nostr-wot/bunker\``);
if (stamp.outputs !== hashOutputs(distDir)) fail(`${distDir} does not match what the build produced (output tampered or missing)`);
console.log(`check:dist: ${distDir} matches its inputs and its stamp`);
