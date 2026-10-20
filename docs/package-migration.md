# Package consolidation migration

This migration is unreleased. It reduces the maintained public packages from 18 to eight by moving implementations into their owners and leaving compatibility re-exports under the old names. There are eight maintained packages and eleven deprecated compatibility names, for 19 workspaces including the new identity package. It does not announce that replacement versions are already published or that npm deprecation has happened.

## Replace package dependencies and imports

| Previous package/import | Maintained import | npm package to install |
| --- | --- | --- |
| `@nostr-wot/relay` | `nostr-wot-sdk/relay` | `nostr-wot-sdk` |
| `@nostr-wot/data` | `nostr-wot-sdk/data` | `nostr-wot-sdk` |
| `@nostr-wot/signers` | `nostr-wot-sdk/signers` | `nostr-wot-sdk` |
| `@nostr-wot/blossom` | `nostr-wot-sdk/blossom` | `nostr-wot-sdk` |
| `@nostr-wot/storage` | `nostr-wot-sdk/storage` | `nostr-wot-sdk` |
| `@nostr-wot/accounts` | `@nostr-wot/identity/accounts` | `@nostr-wot/identity` |
| `@nostr-wot/vault` | `@nostr-wot/identity/vault` | `@nostr-wot/identity` |
| `@nostr-wot/permissions` | `@nostr-wot/identity/permissions` | `@nostr-wot/identity` |
| `@nostr-wot/signer-core` | `@nostr-wot/identity/signing` | `@nostr-wot/identity` |
| `@nostr-wot/bunker` | `@nostr-wot/identity/bunker` | `@nostr-wot/identity` |
| `@nostr-wot/graph` | `@nostr-wot/wot/graph` | `@nostr-wot/wot` |

Preserve supported subpaths: `@nostr-wot/data/react` becomes `nostr-wot-sdk/data/react`, `@nostr-wot/data/cache` becomes `nostr-wot-sdk/data/cache`, `@nostr-wot/relay/react` becomes `nostr-wot-sdk/relay/react`, and `@nostr-wot/graph/react` becomes `@nostr-wot/wot/graph/react`. Use the package export map for less common adapters; never import implementation files from `src/` or `dist/`.

`@nostr-wot/dm`, `@nostr-wot/wallet`, `@nostr-wot/auth`, `@nostr-wot/ui` and `@nostr-wot/pq` retain their package names and existing public entry points. `@nostr-wot/wot` retains its Oracle/bridge API and gains the local graph implementation. `nostr-wot-sdk` becomes the owner of application foundation modules; `@nostr-wot/identity` owns signer-host modules.

## Application example

Before:

```ts
import { fetchProfile } from '@nostr-wot/data';
import { Nip07Signer } from '@nostr-wot/signers';
import { useSession } from '@nostr-wot/data/react';
```

After:

```ts
import { fetchProfile } from 'nostr-wot-sdk/data';
import { Nip07Signer } from 'nostr-wot-sdk/signers';
import { useSession } from 'nostr-wot-sdk/data/react';
```

Once the replacement release is published:

```bash
npm install nostr-wot-sdk nostr-tools
npm uninstall @nostr-wot/data @nostr-wot/signers
# Add React only when using React entry points:
npm install react
```

Remove an old dependency only after all direct imports in your app, tests and tooling have migrated. Commit the updated lockfile with the manifest changes. Existing transitive consumers may still depend on wrappers; a deprecation warning alone does not mean those packages can be removed from another library's dependency tree.

## Signer-host example

```ts
import { Vault } from '@nostr-wot/identity/vault';
import { Permissions } from '@nostr-wot/identity/permissions';
import { SignerCore } from '@nostr-wot/identity/signing';
import { MemoryStore } from 'nostr-wot-sdk/storage';
```

The consolidation changes ownership and import paths. It does not authorize changing vault formats, permission keys, relay privacy policies or account records. Preserve stored records and host authorization behavior while migrating. Follow the existing module guides for any API changes in the versions you install.

## Historical SDK convenience imports

| Compatibility import | Preferred maintained import |
| --- | --- |
| `nostr-wot-sdk` | `@nostr-wot/wot` |
| `nostr-wot-sdk/dm`, `/dm/react` | `@nostr-wot/dm`, `@nostr-wot/dm/react` |
| `nostr-wot-sdk/wallet`, `/wallet/react` | `@nostr-wot/wallet`, `@nostr-wot/wallet/react` |
| `nostr-wot-sdk/auth` | `@nostr-wot/auth` |
| `nostr-wot-sdk/ui` | `@nostr-wot/ui` |
| `nostr-wot-sdk/graph`, `/graph/react` | `@nostr-wot/wot/graph`, `@nostr-wot/wot/graph/react` |

The DM, wallet, auth and UI compatibility exports require the corresponding optional peer package to be installed. WoT remains a direct SDK dependency for root, React and graph compatibility. The SDK no longer promises to install every capability transitively. Declare packages you import in your own `dependencies`; relying on accidental hoisting is fragile.

`nostr-wot-sdk/react` remains a compatibility composition entry with the historical `NostrSdkProvider` and uses the retained WoT dependency. For new React integrations, import data/session primitives from `nostr-wot-sdk/data/react` and WoT hooks/providers from `@nostr-wot/wot/react`. The login components and stylesheet remain in `@nostr-wot/ui`.

## Verify the migration

Build and typecheck your app, then exercise the paths you use: login and restoration, relay teardown, account switching, vault unlock/recovery, message delivery, wallet requests, and graph queries. In React, confirm all capability hooks read the same active session. In server and mobile runtimes, confirm your selected entry points do not require a browser-only adapter.

Use ESM imports for identity modules. Check each package's export map before retaining CommonJS `require` usage; format support is entry-specific and must not be inferred from another package's historical build.

## Release order

Publish the maintained replacement packages and verify their public tarballs and imports before releasing or deprecating compatibility wrappers. Publish wrappers that point to available versions, then add npm deprecation messages naming the maintained package and import path. Never deprecate an old package while its documented replacement is unavailable. An npm warning is a migration notice, not deletion of published versions.

## npm and Node references

See [npm deprecation notices](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) for registry warnings and [Node package entry points](https://nodejs.org/api/packages.html#package-entry-points) for public subpath exports. Deprecation leaves published versions available; the notice should explain the replacement and link to migration instructions.
