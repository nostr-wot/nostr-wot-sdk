/**
 * The platform boundary, enforced rather than promised.
 *
 * `@nostr-wot/storage`, `vault`, `accounts`, `permissions` and `signer-core` exist so that one
 * signer implementation can run in a browser service worker, in Node and under Hermes on a
 * phone. That only holds while none of their source reaches for something one of those
 * runtimes does not have: the WebExtension namespaces, the DOM, WebCrypto, or a UI framework.
 *
 * This is a plain text scan of every file under each package's `src/`, comments included. A
 * comment that says `chrome.` is not a leak, but the rule is deliberately blunt: the literal
 * tokens do not appear in shared source, full stop, so there is nothing to argue about at
 * review time. Tests and generator scripts are outside the scan on purpose; the vault's
 * WebCrypto compatibility suite has to use `node:crypto`'s webcrypto to mean anything.
 *
 * The list of scanned packages is cross-checked against the workspace: every workspace has
 * to be classified as either shared or platform-bound, so adding a package without deciding
 * which it is fails here rather than silently going unscanned. The ESLint config carries the
 * same list and is checked against this one, so the two guards cannot drift apart.
 *
 * Paths are resolved from this file's own location, never from the working directory: a
 * guard that passes because it was run from the wrong folder guards nothing.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');

/** The packages that must stay platform-neutral. Adding one here puts it under the scan. */
const SHARED = ['storage', 'vault', 'accounts', 'permissions', 'signer-core'] as const;

/**
 * Every other workspace, named so that a new package cannot appear without being placed in
 * one list or the other. These are free to depend on a platform; nothing here checks them.
 */
const PLATFORM_BOUND = [
  'auth',
  'blossom',
  'data',
  'dm',
  'graph',
  'pq',
  'relay',
  'sdk',
  'signers',
  'ui',
  'wallet',
  'wot',
] as const;

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /['"]react(-native)?(\/[^'"]*)?['"]/, why: 'imports a UI framework' },
  { pattern: /\bbrowser\./, why: 'reaches for the WebExtension `browser` namespace' },
  { pattern: /\bchrome\./, why: 'reaches for the `chrome` namespace' },
  { pattern: /\bwindow\./, why: 'reaches for the DOM `window`' },
  { pattern: /\blocalStorage\b/, why: 'reaches for `localStorage`' },
  { pattern: /\bcrypto\.subtle\b/, why: 'reaches for WebCrypto' },
];

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return SOURCE_FILE.test(entry) ? [path] : [];
    });
}

function workspaceNames(): string[] {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  return root.workspaces.map((entry) => basename(entry)).sort();
}

describe('the package list', () => {
  test('every workspace is classified as shared or platform-bound, and never both', () => {
    const classified = [...SHARED, ...PLATFORM_BOUND];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(workspaceNames());
  });

  test('every shared package says so in its package.json and has source to scan', () => {
    for (const pkg of SHARED) {
      const manifest = JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')) as {
        name: string;
        keywords?: string[];
      };
      expect(manifest.name, pkg).toBe(`@nostr-wot/${pkg}`);
      expect(manifest.keywords, pkg).toContain('platform-neutral');
      expect(existsSync(join(PACKAGES, pkg, 'src')), `${pkg}/src`).toBe(true);
      expect(walk(join(PACKAGES, pkg, 'src')).length, `${pkg}/src has files`).toBeGreaterThan(0);
    }
  });

  test('the ESLint boundary covers exactly the same packages', async () => {
    const config = (await import(join(ROOT, 'eslint.config.js'))) as {
      SHARED_PACKAGES?: readonly string[];
    };
    expect([...(config.SHARED_PACKAGES ?? [])].sort()).toEqual([...SHARED].sort());
  });
});

describe('the platform boundary', () => {
  test('no shared package reaches for a platform global', () => {
    const violations: string[] = [];
    for (const pkg of SHARED) {
      for (const file of walk(join(PACKAGES, pkg, 'src'))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          for (const { pattern, why } of FORBIDDEN) {
            const match = pattern.exec(line);
            if (match) {
              violations.push(`${relative(ROOT, file)}:${index + 1} ${why}: ${match[0]}`);
            }
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });

  test('the scan sees a violation when one is planted', () => {
    // The guard has to be able to fail. A scan whose patterns never fire is indistinguishable
    // from one that is scanning the wrong directory.
    const planted = [
      "import { useState } from 'react';",
      'const store = browser.storage.local;',
      'chrome.runtime.sendMessage(x);',
      'window.location.reload();',
      "localStorage.getItem('vault');",
      'await crypto.subtle.digest("SHA-256", bytes);',
      '// this used to go through crypto.subtle',
    ];
    for (const line of planted) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(line)), line).toBe(true);
    }
    // ...and stays quiet on things that merely look similar.
    for (const line of [
      "import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';",
      'const timeWindow = windowMs;',
      'const reactive = true;',
      "import { webcrypto } from 'node:crypto';",
    ]) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(line)), line).toBe(false);
    }
  });
});
