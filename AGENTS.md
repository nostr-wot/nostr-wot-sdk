# nostr-wot-sdk

## Upstream SHAs are not durable references

Comments, tests, changesets and docs here explain a guard by pointing at the code it was
ported from, most often in the browser extension. **Do not point at a commit SHA.** The
extension's `main` has been squashed and force-rewritten: every extension SHA this repo
once quoted is unreachable from it, `5659678` is fully dangling, and those objects survive
only in one local clone on one local ref. When they are garbage collected the pointer is
gone for good, and what is left is a comment that explains nothing. The code itself is
still there under different commits, which is why the file is the thing to name.

Commit subject lines are no more durable than the SHAs. A rewrite squashes many changes
into one release commit, so "Harden authentication boundaries" is no longer findable with
`git log --grep` either. Do not lean on it as the anchor.

Anchor on what survives a rewrite:

- the upstream **file path and symbol**, plus the behaviour, for example "the extension's
  `src/domain/signing/authentication.ts` keys a grant on protocol, exact signed URL and
  method" rather than "see `6db46fa`";
- for a shape the upstream has since **replaced**, say so and name what carries the
  current one, so a reader who opens that file is not confused by what they find.
  `requiresDestination` is the live example: it no longer exists, and
  `AuthenticationRequest.crossOrigin` is what expresses the same thing now;
- for a shape the extension spells inline where this repo gives it a name, say that too.
  `AUTHENTICATION_SIGN_KINDS` and `ENDPOINT_GRANT_VERSION` have no upstream counterpart
  as constants.

A SHA may stay where it adds provenance a path cannot, such as recovering code the
upstream has since deleted, but only beside the repository and the files, and marked as
possibly unresolvable, so the sentence still reads when the SHA does not resolve.

Verify a re-anchored citation against the extension's current `main` at
`../nostr-wot-extension` before you write it, and read that clone only: the browser loads
it unpacked, so writing it breaks someone's session.

`grep -rIn '<<<<<<<\|>>>>>>>' packages/` before every commit. A `git add -A` after a
partial conflict resolution has already committed markers in this workspace once.

## NPM Publishing

An `NPM_TOKEN` credential is stored in `.env` (gitignored) and mirrored as the `NPM_TOKEN` GitHub Actions secret on `nostr-wot/nostr-wot-sdk` (used by `.github/workflows/release.yml`). Last rotated **2026-05-10**.

To publish a package (use the npmrc approach — env var alone does not work):

```bash
cd /Users/dandelionlabs/development/personal/nostr-wot-sdk
source .env && npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN
npm run build -w @nostr-wot/<name>   # required: packages no longer self-build on publish
npm run check:dist -w @nostr-wot/<name>   # the published bytes are whatever dist/ holds now
cd packages/<name> && npm publish --access public
```

No package has a `prepack` or a `prepublishOnly` hook, so nothing rebuilds `dist/` during a
pack or a publish. That is deliberate: what goes to npm is then the build that was verified,
not a fresh one made after the gate passed. The cost is that `dist/` has to be there and
current already, which is what `npm run check:dist` says and what
`scripts/release-preflight.mjs` enforces for the whole repo before `changeset publish`
(`npm run release`).
