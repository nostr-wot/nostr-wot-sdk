/**
 * The platform boundary, enforced rather than promised.
 *
 * `@nostr-wot/storage`, `vault`, `accounts`, `permissions` and `signer-core` exist so that one
 * signer implementation can run in a browser service worker, in Node and under Hermes on a
 * phone. That only holds while none of their source reaches for something one of those
 * runtimes does not have: the WebExtension namespaces, the DOM, WebCrypto, or a UI framework.
 *
 * This is a text scan of every file under each package's `src/`, with comments stripped
 * first. The property lives in code, not prose: a comment explaining that the extension
 * supplies `browser.storage` and the app supplies SecureStore is exactly what a reader needs,
 * and a rule that forbids writing it works against us. String literals stay in scope; they
 * are closer to code than to prose, and a false positive there costs one rename. The ESLint
 * rules in `eslint.config.js` work on the AST and are the primary guard; this scan is the
 * belt to their braces. Tests and generator scripts are outside the scan on purpose; the
 * vault's WebCrypto compatibility suite has to use `node:crypto`'s webcrypto to mean anything.
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
  // Everything these packages persist or cache is plain JSON, and a JSON round trip clones
  // that exactly with no host requirement at all. `structuredClone` is a newer global than
  // some of the runtimes we target start with, and it was only ever used on JSON here.
  { pattern: /\bstructuredClone\b/, why: 'uses `structuredClone`; clone JSON with a JSON round trip' },
  // The host's URL parser is not a WHATWG parser everywhere (React Native's folds neither
  // case nor ports). Origins are canonicalised by `canonicalHttpOrigin` in permissions.
  { pattern: /\bnew\s+URL\s*\(|\bURL\.canParse\b/, why: 'parses with the host `URL`; use `canonicalHttpOrigin`' },
];

/**
 * Host capabilities the shared packages DO require, declared rather than avoided.
 *
 * `TextEncoder` and `TextDecoder` cannot realistically be kept out: `@noble/hashes` and
 * `@noble/ciphers` use them internally, and the vault and the accounts package use them for
 * the same UTF-8 conversions. `crypto.getRandomValues` is what `@noble`'s `randomBytes`
 * reaches for (vault salt, IV and cache key; ncryptsec salt and nonce) and it THROWS without
 * it, which is exactly Hermes without `react-native-get-random-values`. `setTimeout` and
 * `clearTimeout` run the vault's auto-lock and the queue's request timeout. Node and browsers
 * have all of them; a React Native host polyfills `crypto.getRandomValues` before importing
 * anything. `AbortController` is what the queue hands a remote-signer port so a timeout, a
 * switch or a disposal can abort the call in flight. They are listed here so that a reader of the FORBIDDEN list does not take their
 * absence for an oversight, and the test below holds every shared package's README to
 * declaring them.
 */
const REQUIRED_HOST_CAPABILITIES = [
  'TextEncoder',
  'TextDecoder',
  'crypto.getRandomValues',
  'setTimeout',
  'AbortController',
] as const;

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/**
 * Blank out `//` and `/* *\/` comments, keeping every newline so line numbers survive, and
 * leaving string and template literals exactly as they are. A `//` inside a regex literal
 * would be taken for a comment and hide the rest of that line; that errs towards a missed
 * hit, never a false one, and the AST rules cover that case.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Copy the literal through its closing quote, honouring backslash escapes.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i]! + source[i + 1]!;
          i += 2;
          continue;
        }
        out += source[i]!;
        i += 1;
      }
      if (i < n) {
        out += quote;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

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

  test('every shared package README declares the host capabilities the family requires', () => {
    for (const pkg of SHARED) {
      const readme = readFileSync(join(PACKAGES, pkg, 'README.md'), 'utf8');
      for (const capability of REQUIRED_HOST_CAPABILITIES) {
        expect(readme, `${pkg}/README.md declares ${capability}`).toContain(`\`${capability}\``);
      }
      expect(readme, `${pkg}/README.md has a host requirements section`).toMatch(/^## Host requirements$/m);
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
        const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
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

  const hits = (source: string) =>
    FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(source)));

  test('the scan sees a violation when one is planted in code', () => {
    // The guard has to be able to fail. A scan whose patterns never fire is indistinguishable
    // from one that is scanning the wrong directory.
    for (const line of [
      "import { useState } from 'react';",
      'const store = browser.storage.local;',
      'chrome.runtime.sendMessage(x);',
      'window.location.reload();',
      "localStorage.getItem('vault');",
      'await crypto.subtle.digest("SHA-256", bytes);',
      'const draft = structuredClone(tree);',
      'const url = new URL(origin);',
      'if (URL.canParse(origin)) return origin;',
      // A string literal is in scope: closer to code than to prose.
      "const api = 'crypto.subtle';",
      'const key = `${prefix}localStorage`;',
    ]) {
      expect(hits(line), line).toBe(true);
    }
  });

  test('the scan stays quiet on comments and on look-alikes', () => {
    for (const source of [
      '// this used to go through crypto.subtle',
      '/** the extension supplies `browser.storage` here, the app supplies SecureStore */',
      '/*\n * multi-line: window.location\n * and chrome.runtime\n */\nexport const x = 1;',
      "const url = 'https://example.test/path'; // window.open used to live here",
      "import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';",
      'const timeWindow = windowMs;',
      'const reactive = true;',
      "import { webcrypto } from 'node:crypto';",
      // Declared requirements, not violations.
      "const bytes = new TextEncoder().encode(text);",
      "const text = new TextDecoder().decode(bytes);",
    ]) {
      expect(hits(source), source).toBe(false);
    }
  });

  test('stripping keeps line numbers and string contents intact', () => {
    const source = "const a = '// not a comment';\n/* gone\n   gone */ const b = 2; // tail\nconst c = 3;";
    const stripped = stripComments(source);
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped).toBe("const a = '// not a comment';\n\n const b = 2; \nconst c = 3;");
  });
});
