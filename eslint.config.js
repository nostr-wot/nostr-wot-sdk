/**
 * ESLint, flat config.
 *
 * The only thing enforced here today is the platform boundary of the shared packages: the
 * portable modules a browser extension and a React Native app both consume, which therefore cannot
 * import a UI framework or reach for a browser global. `packages/identity/test/vault/boundaries.test.ts`
 * scans the same source paths for the same tokens and checks that `SHARED_SOURCE_PATHS` matches its
 * own list, so a module added to one guard and not the other fails the suite.
 *
 * Only `src/` is covered. Tests and generator scripts are free to use Node and its WebCrypto;
 * the vault's compatibility suite depends on exactly that.
 */
import tsParser from '@typescript-eslint/parser';

/** Keep in step with `SHARED` in `packages/identity/test/vault/boundaries.test.ts`. */
export const SHARED_SOURCE_PATHS = [
  'packages/sdk/src/storage',
  'packages/identity/src/accounts',
  'packages/identity/src/vault',
  'packages/identity/src/permissions',
  'packages/identity/src/signing',
];

const FRAMEWORKS = ['react', 'react-native'];
const PLATFORM_GLOBALS = ['browser', 'chrome', 'window', 'localStorage'];
/**
 * Not a platform global, but not assumed either: everything the shared packages clone is
 * JSON, and a JSON round trip does that with no host requirement. `TextEncoder` and
 * `TextDecoder` are the opposite case, declared host requirements (see each README and
 * `REQUIRED_HOST_CAPABILITIES` in the boundary test), and are deliberately not listed.
 */
const AVOIDABLE_GLOBALS = [
  { name: 'structuredClone', message: 'Shared packages clone JSON with a JSON round trip, not structuredClone.' },
  {
    name: 'URL',
    message:
      "The host's URL is not a WHATWG parser everywhere (React Native folds neither case nor ports); use canonicalHttpOrigin / canonicalHostname from @nostr-wot/permissions.",
  },
];

export default [
  {
    // `.interop-extension/` holds copies of the browser extension's sources, staged by the
    // interop probe. They are not ours to lint.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.interop-extension/**'],
  },
  {
    files: SHARED_SOURCE_PATHS.map((path) => `${path}/**/*.ts`),
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FRAMEWORKS.map((name) => ({
            name,
            message: `Shared packages are platform-neutral; ${name} belongs in a host.`,
          })),
          patterns: FRAMEWORKS.map((name) => ({
            group: [`${name}/*`],
            message: `Shared packages are platform-neutral; ${name} belongs in a host.`,
          })),
        },
      ],
      'no-restricted-globals': [
        'error',
        ...PLATFORM_GLOBALS.map((name) => ({
          name,
          message: `Shared packages are platform-neutral; inject a port instead of using ${name}.`,
        })),
        ...AVOIDABLE_GLOBALS,
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'crypto',
          property: 'subtle',
          message: 'Shared packages are platform-neutral; WebCrypto is not available under Hermes.',
        },
        {
          object: 'globalThis',
          property: 'crypto',
          message: 'Shared packages are platform-neutral; WebCrypto is not available under Hermes.',
        },
        ...PLATFORM_GLOBALS.map((name) => ({
          object: 'globalThis',
          property: name,
          message: `Shared packages are platform-neutral; inject a port instead of using ${name}.`,
        })),
        ...AVOIDABLE_GLOBALS.map(({ name, message }) => ({ object: 'globalThis', property: name, message })),
      ],
    },
  },
];
