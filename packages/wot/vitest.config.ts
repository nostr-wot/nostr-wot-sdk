import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', setupFiles: ['./test/graph/setup.ts'], maxWorkers: 2, include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'], testTimeout: 15000 } });
