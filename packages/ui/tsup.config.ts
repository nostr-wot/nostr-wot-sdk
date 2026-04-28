import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2018",
  outDir: "dist",
  treeshake: true,
  splitting: false,
  external: [
    "react",
    "react-dom",
    "nostr-tools",
    "@nostr-wot/data",
    "@nostr-wot/signers",
  ],
  esbuildOptions(o) {
    o.jsx = "automatic";
  },
});
