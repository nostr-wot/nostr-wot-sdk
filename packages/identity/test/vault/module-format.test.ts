/** Identity state must have a single ESM instance; SDK's existing app APIs retain CommonJS. */
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ESM = ['identity', 'storage', 'permissions', 'accounts', 'vault', 'signer-core', 'bunker'];
const DUAL = ['pq', 'signers', 'sdk'];
const manifestOf = (name: string) => JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [entry.name]);
}

describe('public module formats preserve identity state and existing client compatibility', () => {
  test.each(ESM)('%s exposes only ESM imports', (name) => {
    const manifest = manifestOf(name);
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/index.js');
    for (const entry of Object.values(manifest.exports) as Array<{ import?: unknown; require?: unknown }>) {
      expect(entry.import).toBeDefined();
      expect(entry.require).toBeUndefined();
    }
  });

  test.each(ESM)('%s builds only ESM', (name) => {
    const tsup = readFileSync(join(ROOT, 'packages', name, 'tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/["']?format["']?\s*:\s*\[\s*["']esm["']\s*\]/);
    const dist = join(ROOT, 'packages', name, 'dist');
    if (!existsSync(dist)) return;
    expect(files(dist).filter(file => file.endsWith('.cjs') || file.endsWith('.d.cts'))).toEqual([]);
  });

  test('portable storage has no CommonJS export even though other SDK APIs retain it', () => {
    const entry = manifestOf('sdk').exports['./storage'];
    expect(entry.import).toBeDefined();
    expect(entry.require).toBeUndefined();
  });

  test.each(DUAL)('%s retains its existing CommonJS root entry', (name) => {
    expect(manifestOf(name).exports['.'].require).toBeDefined();
  });
});
