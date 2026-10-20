import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', maxWorkers: 2, include: ['src/**/*.test.ts', 'test/**/*.test.ts'], typecheck: {enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.test.json'} } });
