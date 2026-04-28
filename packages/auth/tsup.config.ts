import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "next/index": "src/next.ts",
    "client/index": "src/client/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
  treeshake: true,
  splitting: false,
  external: ["nostr-tools", "@nostr-wot/signers", "jose"],
});
