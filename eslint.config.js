/**
 * ESLint, flat config.
 *
 * The only thing enforced here today is the platform boundary of the shared packages: the
 * ones a browser extension and a React Native app both consume, which therefore cannot
 * import a UI framework or reach for a browser global. `packages/vault/test/boundaries.test.ts`
 * scans the same packages for the same tokens and checks that `SHARED_PACKAGES` matches its
 * own list, so a package added to one guard and not the other fails the suite.
 *
 * Only `src/` is covered. Tests and generator scripts are free to use Node and its WebCrypto;
 * the vault's compatibility suite depends on exactly that.
 */
import tsParser from '@typescript-eslint/parser';

/** Keep in step with `SHARED` in `packages/vault/test/boundaries.test.ts`. */
export const SHARED_PACKAGES = ['storage', 'vault', 'accounts', 'permissions', 'signer-core'];

const FRAMEWORKS = ['react', 'react-native'];
const PLATFORM_GLOBALS = ['browser', 'chrome', 'window', 'localStorage'];

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    files: [`packages/{${SHARED_PACKAGES.join(',')}}/src/**/*.ts`],
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
      ],
    },
  },
];
