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
import { ESLint } from 'eslint';
import { basename, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');

/** Source boundaries, not package names: SDK and identity each contain platform adapters. */
const SHARED = [
  'packages/sdk/src/storage',
  'packages/identity/src/accounts',
  'packages/identity/src/vault',
  'packages/identity/src/permissions',
  'packages/identity/src/signing',
] as const;
const WRAPPERS = ['storage', 'vault', 'accounts', 'permissions', 'signer-core'];
const MIXED = ['sdk', 'identity'];
const PLATFORM_BOUND = ['auth', 'blossom', 'bunker', 'data', 'dm', 'graph', 'pq', 'relay', 'signers', 'ui', 'wallet', 'wot'];
const PLATFORM_MODULES: Record<string, string[]> = {
  identity: ['bunker'],
  sdk: ['auth', 'blossom', 'data', 'dm', 'graph', 'react', 'relay', 'signers', 'ui', 'wallet'],
};

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
  { pattern: /\bURL\b/, why: 'reaches for the host `URL`; use `canonicalHttpOrigin`' },
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
 * switch or a disposal can abort the call in flight. `atob` and `btoa` are what
 * `@nostr-wot/pq`'s base64 helpers reach for, with a `Buffer` fallback Hermes does not have
 * either, and `signer-core` is on their path: it decodes a stored ML-KEM key and reads a
 * payload's envelope header through them. Their absence does not throw, which is why they
 * belong on a declared list rather than being left to be discovered — it silently makes every
 * hybrid payload unrecognisable. They are listed here so that a reader of the FORBIDDEN list
 * does not take their absence for an oversight, and the test below holds every shared package's
 * README to declaring them.
 */
const REQUIRED_HOST_CAPABILITIES = [
  'TextEncoder',
  'TextDecoder',
  'crypto.getRandomValues',
  'setTimeout',
  'AbortController',
  'atob',
  'btoa',
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
  test('every workspace is explicitly classified once', () => {
    const classified = [...WRAPPERS, ...MIXED, ...PLATFORM_BOUND];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(workspaceNames());
  });

  test('every module in a mixed workspace has an explicit boundary', () => {
    for (const pkg of MIXED) {
      const base = `packages/${pkg}/src/`;
      const neutral = SHARED.filter(path => path.startsWith(base)).map(path => path.slice(base.length));
      const classified = [...neutral, ...PLATFORM_MODULES[pkg]!];
      const actual = readdirSync(join(ROOT, base)).filter(name => statSync(join(ROOT, base, name)).isDirectory());
      expect(new Set(classified).size).toBe(classified.length);
      expect(classified.sort(), pkg).toEqual(actual.sort());
    }
  });

  test('every neutral boundary has implementation source to scan', () => {
    for (const path of SHARED) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
      expect(walk(join(ROOT, path)).length, path).toBeGreaterThan(0);
    }
  });

  test('the maintained identity guide declares host capabilities', () => {
    const readme = readFileSync(join(PACKAGES, 'identity', 'README.md'), 'utf8');
    for (const capability of REQUIRED_HOST_CAPABILITIES) {
      expect(readme, capability).toContain(capability === 'setTimeout' ? 'timers' : capability);
    }
  });

  test('the ESLint boundary covers exactly the same source paths', async () => {
    const config = (await import(join(ROOT, 'eslint.config.js'))) as { SHARED_SOURCE_PATHS?: readonly string[] };
    expect([...(config.SHARED_SOURCE_PATHS ?? [])].sort()).toEqual([...SHARED].sort());
  });
});

describe('the platform boundary', () => {
  test('no shared package reaches for a platform global', () => {
    const violations: string[] = [];
    for (const pkg of SHARED) {
      for (const file of walk(join(ROOT, pkg))) {
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

  /**
   * Every form each FORBIDDEN entry exists to catch. A guard that matches one spelling of a
   * thing and not the others is a guard that has been passed once already: `new URL(` was
   * matched while `URL.parse(` and `new globalThis.URL(` were not.
   */
  const NEGATIVE_CONTROLS: ReadonlyArray<[string, string]> = [
    ['react import', "import { useState } from 'react';"],
    ['react-native import', "import { View } from 'react-native/Libraries/Components/View/View';"],
    ['browser namespace', 'const store = browser.storage.local;'],
    ['chrome namespace', 'chrome.runtime.sendMessage(x);'],
    ['window', 'window.location.reload();'],
    ['localStorage', "localStorage.getItem('vault');"],
    ['crypto.subtle', 'await crypto.subtle.digest("SHA-256", bytes);'],
    ['structuredClone', 'const draft = structuredClone(tree);'],
    ['new URL', 'const url = new URL(origin);'],
    ['URL.parse', 'const url = URL.parse(origin);'],
    ['URL.canParse', 'if (URL.canParse(origin)) return origin;'],
    ['new globalThis.URL', 'const url = new globalThis.URL(origin);'],
    ['globalThis.URL.parse', 'const url = globalThis.URL.parse(origin);'],
    ['URL as a value', 'const Parser = URL; new Parser(origin);'],
  ];

  test.each(NEGATIVE_CONTROLS)('the scan catches %s', (_name, line) => {
    expect(hits(line), line).toBe(true);
  });

  test.each(NEGATIVE_CONTROLS)('ESLint catches %s in a shared package', async (_name, line) => {
    // Linted as if it were a file in a shared package's src, through the real config: the
    // rule set is what runs in CI, not a re-statement of it here.
    const eslint = new ESLint({ cwd: ROOT });
    const [result] = await eslint.lintText(`export const probe = () => { ${line} };\n`, {
      filePath: join(PACKAGES, 'identity', 'src', 'permissions', 'probe.ts'),
    });
    expect(result!.errorCount, `${line}\n${result!.messages.map((m) => m.message).join('\n')}`).toBeGreaterThan(0);
  });

  test('ESLint is quiet on a clean line in a shared package, so the controls above mean something', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const [result] = await eslint.lintText("export const probe = (text: string) => new TextEncoder().encode(text);\n", {
      filePath: join(PACKAGES, 'identity', 'src', 'permissions', 'probe.ts'),
    });
    expect(result!.errorCount, result!.messages.map((m) => m.message).join('\n')).toBe(0);
  });

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
      "const bunkerUrl = account.nip46Config.bunkerUrl; const BUNKER_URL = 1;",
      "const params = new URLSearchParams(query);",
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
