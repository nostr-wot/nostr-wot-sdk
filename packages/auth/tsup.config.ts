import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "next/index": "src/next.ts",
    "client/index": "src/client/index.ts",
  },
  format: ["cjs", "esm"],
  dts: { compilerOptions: { rootDir: '../..' } },
    tsconfig: 'tsconfig.build.json',
  clean: true,
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
  treeshake: true,
  splitting: false,
  external: ["nostr-tools", "nostr-wot-sdk/signers", "jose"],
});
