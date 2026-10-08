import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
}

describe('built package entrypoints', () => {
  it('retains every declared runtime and type entrypoint in the same build', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const target of targets(manifest.exports)) {
      expect(existsSync(new URL(`../${target}`, import.meta.url)), target).toBe(true);
    }
  });
});
