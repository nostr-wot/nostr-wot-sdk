# CLAUDE.md

## NPM Publishing

An `NPM_TOKEN` credential is stored in `.env` (gitignored) and mirrored as the `NPM_TOKEN` GitHub Actions secret on `nostr-wot/nostr-wot-sdk` (used by `.github/workflows/release.yml`). Last rotated **2026-05-10**.

To publish a package (use the npmrc approach — env var alone does not work):

```bash
cd /Users/dandelionlabs/development/personal/nostr-wot-sdk
source .env && npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN
cd packages/<name> && npm publish --access public
```
