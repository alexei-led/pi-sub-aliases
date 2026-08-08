# Changelog

## 0.2.2

### Fixed

- Every aliased provider — Claude and Codex alike — stopped working once its
  OAuth access token expired. `adaptOAuth` dropped the `AbortSignal` pi passes
  as the second argument to `refreshToken`, and pi-ai's token request builds
  `AbortSignal.any([signal, timeout])`, which throws `ERR_INVALID_ARG_TYPE` on
  `undefined`. Every request then failed with `OAuth refresh failed for
  <alias>`, and the only recovery was a fresh login.

## 0.2.1

### Fixed

- Aliases work on a stock pi install. OAuth flows now come from
  `@earendil-works/pi-ai/providers/all` instead of `pi-ai/compat`, which never
  exported them — previously every alias silently disappeared (no login entries,
  no alias models) unless pi-ai was patched locally.

### Changed

- Requires Pi 0.82.1 or newer (declared as `>=0.82.1`, no upper bound)

## 0.2.0

### Breaking

- Package renamed `pi-claude-alias` → `pi-sub-aliases`; install `npm:pi-sub-aliases`
- Config file renamed `claude-alias.json` → `sub-aliases.json` (global and project);
  no legacy fallback
- Footer status key renamed `claude-alias` → `sub-aliases`

### Added

- OpenAI Codex alias support: `"provider": "openai-codex"` entries create
  `openai-codex-<slug>` providers with separate OAuth slots
- Codex stream wrapper so aliased Codex models stream through Pi's built-in
  `openai-codex` path (derived from CarlosGtrz/carlosgtrz-pi-extensions, MIT)
- Codex env sync (`OPENAI_CODEX_*`, `CHATGPT_ACCOUNT_ID`) with `pi-sub-bar` refresh
  on model select

### Migration

- Replace `npm:pi-claude-alias` (and `npm:@carlosgtrz/pi-codex-aliases`) with
  `npm:pi-sub-aliases` in `~/.pi/agent/settings.json`
- Move `~/.pi/agent/claude-alias.json` to `~/.pi/agent/sub-aliases.json`
- Provider ids are unchanged, so stored OAuth credentials and `model-router.json`
  patterns keep working — no re-login needed

## 0.1.x

- Production-ready package metadata for `pi-claude-alias`
- Focused tests for alias registration, model copying, metadata preservation, auth separation, and package contents
- CI workflow for lint, typecheck, tests, and `npm pack --dry-run`
- Publish workflow for tagged npm releases with `NPM_TOKEN` and provenance
- Release guide and manual verification steps using a temporary `PI_CODING_AGENT_DIR`
- Alias registration derives login labels from Pi's built-in Anthropic OAuth provider name
- Alias registration safely handles an empty built-in Anthropic catalog while still registering OAuth-capable providers
- Alias model refresh tracks all copied metadata, not just ids and token limits
