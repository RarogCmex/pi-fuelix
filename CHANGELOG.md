# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

## [0.1.4] — 2026-11-03

**Re-verified against pi 1.5.0** (2026-11-03): `npm run typecheck` clean, **130/130**
offline tests green, and `pi -ne -e <repo> --offline --list-models fuelix` prints the
same **98** models. This is a host-migration release: no provider, catalog or wire
behaviour changed.

- **Fixed — the one real break in 1.5.0.** pi-ai 1.5.0 no longer re-exports TypeBox;
  pi maps an extension's `Type`/`Static`/`TSchema` import to the compat entry plus the
  TypeBox it bundles at runtime, but `tsc` sees neither, so `npm run typecheck` failed
  with `TS2305: has no exported member 'Type'` in `test/wire-format.test.ts` and
  `live/check.ts`. Both now import `Type` from `typebox` directly (the form the 1.5.0
  docs prescribe for new code), and `scripts/link-pi.mjs` links the host's bundled
  `typebox` next to pi and pi-ai. The test assertions are unchanged.
- **First `CHANGELOG.md`.** pi 1.5.0 reads `<package>/CHANGELOG.md` (or
  `pi.changelogPath`) and shows entries newer than the last seen version on the first
  fresh launch; a git package only moves when `version` grows, hence the patch bump.
  `pi.changelogPath` is not set — the file is at the package root, which pi reads by
  default.
- **Not adopted from 1.5.0, deliberately.** This package registers no tools, so the
  pi-schema validation change and its coercion rules do not reach it. `keyText()`/
  `keyHint()` need a custom tool renderer (none is registered); `blocked` on
  `ctx.ui.custom()` needs an inline custom UI (`/login fuelix` uses `ui.select`/
  `ui.input`); `pi.exec()` `maxBuffer`/`truncated` is moot because `pi.exec()` is never
  called; `Usage.cost.totalFromProvider` and `responseModel` are filled by the host
  runtime; GPT-6.1 Terra, the models.dev v2 catalog and the changed host defaults are
  host catalogs, not this gateway's; MCP OAuth client registration does not apply.
  `collapseChangelog` is a host setting that starts working on its own now that the
  changelog exists.

## [0.1.3] — 2026-10-22

Re-verified on pi 1.4.0: typecheck clean and 130/130 offline tests green; no provider
surface moved in 1.4.0 for this package.

## [0.1.2] — 2026-10-06

Re-verified on pi 1.0.4: the offline suite and the typecheck are green; no code change
was needed for the 1.0.0→1.0.4 host delta.

## [0.1.1] — 2026-09-30

Install path exercised against the public repo and tested on pi 0.99.1; the error-body
tests now assert the adapter invariant rather than pi 0.87.1's lossy-body behaviour.

## [0.1.0] — 2026-09-26

Initial release: the fuelix.ai gateway provider — the 98-id chat catalog of the 111-id
LiteLLM listing, `/login`, the additive `/v1/models` overlay, the error layer for the
gateway's RFC 7807 / `{"detail"}` / 403-entitlement dialects, the paced A–H live
harness and the offline suite.
