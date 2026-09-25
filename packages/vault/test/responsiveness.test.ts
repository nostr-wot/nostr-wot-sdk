/**
 * Password stretching must not freeze the host.
 *
 * At the shipping work factor a derivation is roughly a second of pure JavaScript. On a phone
 * that second is the moment the user is unlocking their keys, and whether the UI is frozen for
 * it depends entirely on whether `pbkdf2Async` yields to the event loop. `@noble/hashes` 2.0.1
 * does not: it awaits a microtask, so zero timer ticks pass in a full second. 2.4.0 yields
 * through `setTimeout(0)` and the loop stays responsive. This is measured, not reasoned, and it
 * is why the dependency floor is 2.4.0 rather than the range that happened to install.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { noblePbkdf2 } from '../src/crypto.js';
import { VAULT_PBKDF2_ITERATIONS } from '../src/constants.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const NOBLE_HASHES_FLOOR = [2, 4, 0] as const;

function parseVersion(text: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) throw new Error(`not a version: ${text}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! > floor[i]!) return true;
    if (version[i]! < floor[i]!) return false;
  }
  return true;
}

describe('password stretching yields to the event loop', () => {
  test('timer ticks pass during a derivation at the shipping work factor', { timeout: 60_000 }, async () => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await noblePbkdf2.derive('correct horse battery staple', new Uint8Array(32).fill(7), VAULT_PBKDF2_ITERATIONS);
    } finally {
      clearInterval(interval);
    }
    // 2.0.1 measures exactly zero here: a second of derivation, no tick, a frozen UI.
    expect(ticks).toBeGreaterThan(0);
  });

  test('every shared package that derives with @noble/hashes declares the 2.4.0 floor, and resolves one', () => {
    // Resolved from each package's own source, the way its imports resolve: the hoisted copy at
    // the root belongs to @noble/curves and @scure (still ^2.0.1) and is not what vault or
    // accounts load. A check of the root copy would have failed here while both packages ran
    // 2.4.0, and passed if the two nested copies ever silently went away.
    for (const pkg of ['vault', 'accounts']) {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      const range = manifest.dependencies['@noble/hashes']!;
      expect(range, `${pkg} declares @noble/hashes`).toBeDefined();
      expect(atLeast(parseVersion(range), NOBLE_HASHES_FLOOR), `${pkg}: ${range} floors at 2.4.0`).toBe(true);

      const resolve = createRequire(join(ROOT, 'packages', pkg, 'src', 'index.ts')).resolve;
      const entry = resolve('@noble/hashes/pbkdf2.js');
      const installed = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string };
      expect(atLeast(parseVersion(installed.version), NOBLE_HASHES_FLOOR), `${pkg} resolves ${installed.version}`).toBe(true);
    }
  });
});
