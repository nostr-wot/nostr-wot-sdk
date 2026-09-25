import { defineConfig } from 'tsup';
import { stampDist } from '../../scripts/dist-stamp.mjs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  // Stamp dist/ with a hash of what it was built from; `npm run check:dist` compares. A
  // function, not a shell string: tsup 8.5 runs a string through tinyexec, which mangles
  // any `../` in it, and the script lives at the repo root.
  onSuccess: async () => {
    stampDist(process.cwd());
  },
});
