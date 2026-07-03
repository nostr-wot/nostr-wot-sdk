import { defineConfig } from 'tsup';

const JSX_AUTO = {
  esbuildOptions(o: { jsx?: string }) {
    o.jsx = 'automatic';
  },
};

export default defineConfig([
  {
    ...JSX_AUTO,
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
  },
  {
    ...JSX_AUTO,
    entry: ['src/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/react',
    treeshake: true,
    splitting: false,
    external: ['react'],
  },
]);
