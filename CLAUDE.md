# CLAUDE.md

## NPM Publishing

An `NPM_TOKEN` credential is stored in `.env` (gitignored). It expires **2026-05-06** (7 days from 2026-04-29).

To publish a package:

```bash
source .env && cd packages/<name> && NPM_TOKEN=$NPM_TOKEN npm publish --access public
```

Or configure `.npmrc` before publishing:

```bash
source .env && npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN
cd packages/<name> && npm publish --access public
```
