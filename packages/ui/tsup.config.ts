import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: { compilerOptions: { rootDir: '../..' } },
    tsconfig: 'tsconfig.build.json',
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
    "nostr-wot-sdk/data",
    "nostr-wot-sdk/signers",
  ],
  esbuildOptions(o) {
    o.jsx = "automatic";
  },
});
