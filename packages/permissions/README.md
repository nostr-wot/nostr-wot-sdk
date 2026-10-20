# @nostr-wot/identity/permissions

> Package consolidation: this is the API guide for `@nostr-wot/identity/permissions`. The former `@nostr-wot/permissions` package is a deprecated compatibility re-export. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

The authorization layer every `@nostr-wot/*` signer funnels through: given a caller, a method and an event kind, may this happen.

NIP-07 in a browser extension, NIP-55 from an Android app and NIP-46 from a remote signer differ in how a request arrives, not in who is allowed to make it. So the decision lives here once, over an injected [`KeyValueStore`](../storage), and touches no platform global.

## Install

```bash
npm i @nostr-wot/identity
```

### Module format

Use ESM `import` as shown here. Module-format support is specific to the owning package and entry point; do not infer it from another package in the family. The identity entry points are ESM-only.

## The cascade

Three levels are consulted, most specific first: the kind-specific key (`signEvent:1`), the method-level key (`signEvent`), then the wildcard (`*`).

**Deny wins.** An explicit `deny` at any consulted level ends the matter. A kind-specific `allow` cannot override a method-level or wildcard `deny`, and a broad `*` allow cannot bypass a narrower deny. Only when nothing denies does specificity decide, in the order kind > method > wildcard. A bucket that says nothing about a request returns `ask`.

```ts
import { resolve } from '@nostr-wot/identity/permissions';

resolve({ '*': 'allow' }, 'signEvent', 1); // 'allow'
resolve({ 'signEvent:1': 'allow', '*': 'deny' }, 'signEvent', 1); // 'deny'
resolve({}, 'signEvent', 1); // 'ask'
```

`resolve` is pure, so the security critical part of this package is testable without storage.

## Permission keys

| Method | Key |
| --- | --- |
| `signEvent`, kind 1 | `signEvent:1` |
| `signEvent`, kinds 4 / 13 / 14 / 1059 | `sendMessages` |
| `nip04Encrypt`, `nip44Encrypt` | `sendMessages` |
| `nip04Decrypt`, `nip44Decrypt` | `readMessages` |
| `webln_*` | unchanged |
| anything else | its own name |

The DM kinds collapse so one approval covers the whole send-a-DM flow, encrypt and the matching signature, instead of prompting twice. The consequence is deliberate: denying sign-of-DM-kind without also denying encrypt is not expressible, because it is one decision.

Because of that collapse, nothing ever consults a raw `signEvent:4`, `:13`, `:14` or `:1059` key, so `saveDirect` **throws** on one rather than storing a rule that can never fire. Write `sendMessages`, or go through `save`, which maps the kind for you.

## Usage

```ts
import { MemoryStore } from 'nostr-wot-sdk/storage';
import { Permissions } from '@nostr-wot/identity/permissions';

const permissions = new Permissions(new MemoryStore(), { logger: console });

await permissions.migrate(); // once per store, safe to call on every start

if ((await permissions.check('example.com', 'signEvent', 1, accountId)) === 'ask') {
  const decision = await promptTheUser();
  await permissions.save('example.com', 'signEvent', 1, decision, accountId);
}
```

An `origin` is whatever identifies the caller: a web origin, an Android package name, a remote signer's public key. Only `http(s)` origins additionally answer to their bare hostname, which is how rules stored by older versions are still read.

An `http(s)` origin is stored and read under one canonical spelling, computed by `canonicalHttpOrigin` in this package rather than by the host's `URL`: scheme and host lowercased, a default port dropped, IPv4 and IPv6 addresses written one way, and anything with credentials or a path refused. React Native's `URL` folds neither case nor ports, so a check built on `new URL(x).origin === x` would let `https://EXAMPLE.COM` and `https://example.com:443` each hold their own rules on a phone; `test/origin.test.ts` runs the same table under a `URL` shaped like React Native's and checks the parser is never consulted.

**Every mutating method throws on an empty origin, key or account id.** `''` type-checks wherever a label is expected and means nothing, so it is treated as a caller bug rather than as a wildcard or a no-op — notably `clear('')`, which does *not* mean "wipe everything" (omit the argument for that). Reads stay tolerant: an unknown origin resolves to `ask`, and a check that throws into a signing path would be worse than one that prompts. `undefined` and `null` keep their documented meanings.

## Global rules and inheritance

Existing stores retain their legacy mode until migrated: shared per-site `_default` buckets or isolated account buckets. `migrate()` performs the original schema migrations only. Then call `migrateToGlobalRules({ accountIds, origins })`, supplying every account and connected caller from host state. It first enables inheritance, then consolidates shared rules under `_global._default`. The existing extension markers `signerRulesInheritance` and `signerGlobalRulesVersion` are recognized on read.

Consolidation chooses the most restrictive shared decision and preserves existing account/site behavior through explicit overrides, including `ask` where the site previously had no decision. New sites inherit the consolidated rules. Dormant account rules are discarded when migrating from shared mode; dormant shared allows cannot become active for existing accounts in isolated mode. Supply the full host inventory because the library cannot discover accounts or connected sites outside permission storage.

Resolution layers are shared global rules, legacy account-wide rules, legacy shared site rules, then account/site overrides. An explicit `ask` or `allow` replaces an inherited decision for the same key; a denial under another consulted key still wins through the permission cascade. Consolidated writes require `_global` with `_default` for global settings and an explicit account for site settings. The old mode flag no longer changes inherited resolution. Missing account ids continue to fail closed.

`inheritRule(origin, key, accountId)` removes that account's override across exact and legacy hostname scopes. `clearRuleBucket(origin, accountId)` removes ordinary rules only. `resetAccountRules()` removes all account overrides while retaining shared rules. These settings operations retain authentication grants; disconnection and account deletion continue to revoke those grants. In consolidated storage, `setupNewAccountPermissions(..., null)` inherits global rules; selecting a source copies its site overrides.

Migrations use a durable journal because the injected storage port has no atomic multi-key write. An incomplete migration refuses authorization until a migration call successfully resumes it, including after process restart. Use one `Permissions` instance per store and serialize migration with other host initialization. Browser settings UI and connected-site inventory remain host responsibilities.

## Authentication destinations

A kind-22242 (NIP-42) or kind-27235 (NIP-98) event is not a publication, it is a **credential**, addressed to the relay or HTTP service named in its `relay` or `u` tag. A permission keyed by method and event kind cannot express that, so a remembered `signEvent:22242 = allow` is a credential for every relay a caller subsequently names: [GHSA-vx4h-56qj-wcp7][ghsa].

So those events get their own question, with five parts instead of two.

```ts
import { parseAuthentication, Permissions } from '@nostr-wot/identity/permissions';

const permissions = new Permissions(store);

// Throws for an authentication event that is invalid; undefined for an ordinary event.
const auth = parseAuthentication(event, origin);
if (auth) {
  const decision = await permissions.authentication.decisionFor(accountId, origin, auth);
  if (decision === 'deny') throw new Error('Authentication permission denied');
  if (decision !== 'allow') {
    // Prompt, naming auth.destination and auth.method. The scope the user picked must pass
    // validAuthenticationScope: 'once', 'site', or 'connected-sites' for a relay only.
    await permissions.authentication.save(accountId, origin, auth, scope, () => assertSession());
  }
}
```

`parseAuthentication` refuses credentials in the address, a fragment, control characters, a backslash, surrounding whitespace, a non-loopback plain-`http`/`ws` destination, competing tags, non-empty content, a bad HTTP method or payload digest, and an event older than 600 seconds (NIP-42) or 60 (NIP-98). It refuses a requesting origin that is not already canonical, because a host that passes a page URL through has not resolved the caller's identity. An `origin` or `client-origin` tag is metadata and never evidence, but it must not contradict the origin the host derived: otherwise one string is shown while the other is authorised.

**Scope.** A NIP-42 grant is keyed by the canonical relay URL, path and query kept. A NIP-98 grant is keyed by the **exact signed URL**, query bytes included and nothing normalised or sorted, because a user shown `POST https://api.example/login` did not consent to `POST https://api.example/transfer`. Such a record carries `version: 2` and a `resource`; a NIP-98 record written before endpoint scoping has neither, and its `allow` is never honoured again — its holder is asked once more at the narrower scope, and the record stays listed and revocable rather than being silently upgraded. A legacy `deny` keeps its broad reach, since narrowing a refusal is the one direction that loses protection.

Three ordering properties hold, and each has its own test:

- **Deny wins.** A site-specific `deny` beats a shared relay `allow`. Only an explicit
  revocation lifts it.
- **`*` is NIP-42 only.** `connected-sites` stores the origin `*`, honoured for a relay and never
  for an HTTP service, whatever a stored record claims.
- **A queued approval re-checks.** The deny check runs inside the write lock, after the read, so an
  approval waiting on the lock cannot overwrite a rejection saved while it waited.

`Permissions` owns the grant store rather than taking one, so `clear`, `clearAllForOrigin` and `clearForAccount` cannot forget to revoke the credentials they leave behind.

A stored `signEvent:22242` **allow** never authorises. `check` answers `ask` for that kind however broadly the bucket allows, because the key names no relay and buckets in the field already hold one; `saveDirect` refuses to write another. A `deny` is honoured at every level, since a refusal in force is a refusal. `signEvent:27235` is deliberately untouched: the cascade is not given the origin, so it cannot tell a same-origin NIP-98 request from a cross-origin one, and `SignerCore` closes that half by never remembering an allow for either kind.

[ghsa]: https://github.com/advisories/GHSA-vx4h-56qj-wcp7

## Storage compatibility

Keys and shape are the browser extension's, unchanged, so a migrated extension reads its own data:

```json
{
  "signerPermissions": {
    "example.com": { "_default": { "signEvent:1": "allow" }, "acct_abc": { "*": "deny" } }
  },
  "signerUseGlobalDefaults": true,
  "authenticationGrants": [
    {
      "id": "[\"acct_abc\",\"*\",\"nip42\",\"wss://relay.example/\",\"\"]",
      "decision": "allow",
      "accountId": "acct_abc",
      "origin": "*",
      "protocol": "nip42",
      "destination": "wss://relay.example/"
    }
  ]
}
```

`migrate()` runs the four migrations in order — blanket keys dropped, flat rules bucketed under `_default`, the retired `forward` value rewritten to `ask`, and DM kinds folded into `sendMessages` most-restrictive-wins — then records `_permMigrationVersion`.

## Optional authentication policies

`parseAuthentication(event, origin, now, { legacyLoginOrigins })` can recognize a narrow nonstandard domain/challenge login for exact HTTPS origins explicitly supplied by the host. The default allowlist is empty. The domain must match the caller, the challenge must be nonblank, the event must be fresh with empty content, and extra tags are rejected. The resulting `legacy-login` request supports only `once`; stored grants and backend defaults never authorize it. The host must show a warning and obtain explicit consent for every such request.

### Requesters that are not web pages

`parseAuthentication` also takes an `AuthenticationRequester` in place of the origin string: `{ kind: 'web', origin }`, `{ kind: 'nip46', clientPubkey }`, `{ kind: 'nip55', packageName, signatureDigest? }`, `{ kind: 'lan', peerId }` or `{ kind: 'local', id }`. A `web` requester is parsed exactly as the string is. Every other kind cannot prove an origin, so an `origin` or `client-origin` tag refuses the event outright, the request is `crossOrigin` for both protocols, and legacy login is refused. The requester is validated first, so a malformed identity is refused before the event is read.

`authenticationRequesterKey(requester)` is the string a grant for it is stored under: the canonical origin for a page (the label `AuthenticationGrants` already keys on, so a browser host's grants keep matching), `kind:identifier` for everything else. The two can never meet: a canonical origin begins with `http://` or `https://`, a prefixed key with one of the fixed non-web kinds and a colon. `nip55.signatureDigest` is carried for the host's policy and display and is deliberately not part of the key, so a grant list already keyed on package names migrates intact. `AuthenticationGrants` reads and writes these keys unchanged; `storageLabel` passes a non-web key through. `save` awaits its `assertCurrent`, so the host's check can be a real re-read of the active account, and an allow that finds a deny in force throws an `AuthenticationDeniedError` (its `name` is `AUTHENTICATION_DENIED_ERROR`, for a caller sitting above two different stores).

`Permissions` and `AuthenticationGrants` accept `backendRegistry: [{ origin, destination, protocol: 'nip98' }]`. No client registry or project-specific compatibility policy is bundled. `authentication.setDefaultBackendAuth(accountId, true)` explicitly opts that account into same-origin HTTPS authentication and exact registry pairs. It is off by default, excludes relay and legacy login requests, and an explicit destination denial wins. Account-wide or full revocation also clears this setting; revoking one site's grants does not change the account-wide preference. The host remains responsible for trusted registry maintenance and privileged endpoint policies.

## Host requirements

The portable account, vault, permission and signing modules use injected storage and host ports. They require `TextEncoder`, `TextDecoder`, secure `crypto.getRandomValues`, timers and `AbortController`; post-quantum paths additionally require `atob`/`btoa` or the supported Buffer fallback. Initialize the necessary React Native/Hermes polyfills before importing these modules, including `react-native-get-random-values` for secure randomness. Do not substitute a non-cryptographic random source.

The portable cryptographic core does not require the DOM, WebExtension APIs or WebCrypto `subtle`. Platform adapters such as WebAuthn ceremonies and relay transports have their own requirements. See the [identity runtime guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/identity/README.md#runtime-requirements).

This package itself uses neither `TextEncoder` nor `TextDecoder`, and clones the permission tree with a JSON round trip. Its origin parsing is its own and never consults the host's `URL`.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
