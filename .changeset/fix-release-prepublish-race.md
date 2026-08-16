---
'@nostr-wot/dm': patch
---

Drop the per-package `prepublishOnly` build hook, which made releases race against themselves.

`release.yml` builds every package before publishing, and `npm run release` builds them again before `changeset publish`. Each package then rebuilt itself a third time during publish. Because `tsup` cleans `dist/` before it writes, a package whose types another package imports could have its `dist/` emptied at the moment that other package's DTS step ran, so the build failed with `TS2307: Cannot find module '@nostr-wot/signers'` or `TS7016: implicitly has an 'any' type`.

That failure hit two consecutive releases and left `@nostr-wot/dm` unpublished both times while every other package went out, so `main` and npm disagreed about its version.

Publishing manually from a package directory now requires building first; `CLAUDE.md` says so.
