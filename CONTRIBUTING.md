# Contributing

## Setup

```bash
git clone git@github.com:nostr-wot/nostr-wot-sdk.git
cd nostr-wot-sdk
npm install
npm run build
```

## Releases — changeset workflow

This repo uses [changesets](https://github.com/changesets/changesets) for version management. Every PR that changes published code must include a changeset describing the bump.

### Adding a changeset

After making your changes, run:

```bash
npx changeset
```

You'll be asked:

1. **Which packages bumped?** Pick the affected ones — `@nostr-wot/data`, `@nostr-wot/relay`, `@nostr-wot/wot`, and/or `nostr-wot-sdk`.
2. **Major / minor / patch?** Per package. Note: the four packages are `linked` in `.changeset/config.json`, so they all end up at the same version on release. Bumping any single one moves them all.
3. **Summary.** A short prose description that becomes the CHANGELOG entry. Markdown is fine.

A new file lands in `.changeset/<name>.md`. Commit it with the rest of your PR.

### What CI does

On push to `main`:

- If `.changeset/*.md` files exist, CI opens (or updates) a "chore: release" PR with bumped versions in `package.json`s + CHANGELOG entries written.
- When that PR merges, CI runs `npm run release` which publishes every package whose `package.json` version doesn't yet exist on npm.

You don't manually `npm publish`. You don't manually edit `package.json` versions. Just write changesets.

### Skipping the changeset (docs / refactor only)

If your PR is doc-only or non-publishing, run:

```bash
npx changeset --empty
```

This adds a placeholder so CI doesn't complain that a changeset is missing, but no version bumps.

## Adding a new package

1. `mkdir packages/<name>/src`
2. Add `package.json` (copy `packages/data/package.json` as a template; update name/description)
3. Add `tsconfig.json` extending `tsconfig.base.json`
4. Add `tsup.config.ts`
5. Add to root `package.json`'s `workspaces` array
6. Add to root `build` script (in dependency order)
7. Add to `.changeset/config.json`'s `linked` group if it should version in lock-step
8. `npm install` (resyncs workspaces)

## Style

- TypeScript strict mode in `tsconfig.base.json`. Per-package overrides for legacy code if needed.
- Two-space indent, single quotes, semicolons.
- Default to no comments. Comment only the *why* (a constraint, an invariant, a workaround). Don't comment the *what*.

## Testing

```bash
npm test           # all packages
npm run test -w @nostr-wot/data   # one package
```
