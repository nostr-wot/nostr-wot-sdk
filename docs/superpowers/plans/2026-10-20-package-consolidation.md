# Package consolidation implementation plan

Goal: eight maintained packages with explicit subpath APIs, eleven compatibility wrappers, and concise usable documentation. User approved the mapping and implementation on 2026-10-20.

Architecture: move implementation ownership into SDK, identity and WoT; retired packages forward to the new modules. Keep framework, server-auth, wallet, messaging and PQ domains separate. Existing umbrella compatibility entries use optional peers to avoid making SDK depend on its consumers. Legacy umbrella users must explicitly install the requested domain package in this major release.

## Tasks

- [x] Record old public export map and test the new ownership/wrapper contracts before editing implementation.
- [x] Move relay/data/signers/Blossom/storage into SDK subpaths; accounts/vault/permissions/signing/bunker into identity; graph into WoT. Rewrite internal imports to relative owned modules or maintained package imports. Preserve all public symbols, tests and notices.
- [x] Replace retired implementations with forwarding entrypoints preserving ESM/CJS support where present. Update maintained consumers, versions, build order, exports and dependency ranges. Check no hard dependency cycles or retired implementation dependencies remain.
- [x] Rewrite README files and migration/use-case docs, mark retired names with exact replacement paths and an unreleased notice. Prepare registry deprecation command that refuses unpublished replacement versions; do not deprecate live packages prematurely.
- [x] Build, typecheck and run existing behavior tests. Pack all workspaces, install the tarballs into an isolated consumer and verify legacy/new export equivalence, ESM/CJS, types and shared runtime state. Test runtime roots do not require optional React/server/identity packages.
- [x] Review diff and document outcome. Commit by function. No npm release or deprecation mutation before replacements are published; no production website deployment as part of this migration.

## Documentation follow-through

Website docs hierarchy remains a pending linked task, now organized around the eight responsibility groups rather than eighteen top-level package names. Preserve existing URL anchors, localizations, SEO and examples when moving them to dedicated pages. SDK migration docs must describe unreleased structure honestly until publication.

## Verification

All 1,691 workspace tests pass, including identity type contracts. Builds, typechecks, lint, four package-layout checks and release preflight pass. Fresh npm tarball consumers verify legacy/replacement export identity in ESM and supported CommonJS, TypeScript compatibility and core operation without React or optional capability packages. Registry deprecation remains unapplied until replacements are published.
