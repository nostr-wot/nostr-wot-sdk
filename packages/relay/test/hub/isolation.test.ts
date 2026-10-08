import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../src/hub/', import.meta.url);

describe('hub package boundary', () => {
  it('depends only on its own implementation and nostr-tools', () => {
    const files = readdirSync(root).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20);
    const invalid: string[] = [];
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, root)), 'utf8');
      for (const match of source.matchAll(/(?:import|export)[^'";]*?from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('./') && specifier !== 'nostr-tools' && !specifier.startsWith('nostr-tools/')) invalid.push(`${file}: ${specifier}`);
      }
    }
    expect(invalid).toEqual([]);
  });
});
