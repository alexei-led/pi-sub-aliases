# pi-sub-aliases

[![npm](https://img.shields.io/npm/v/pi-sub-aliases)](https://www.npmjs.com/package/pi-sub-aliases)
[![CI](https://github.com/alexei-led/pi-sub-aliases/actions/workflows/ci.yml/badge.svg)](https://github.com/alexei-led/pi-sub-aliases/actions/workflows/ci.yml)
[![Pi extension](https://img.shields.io/badge/pi-extension-6f42c1)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Use multiple Claude and ChatGPT subscriptions in Pi without logging in and out of the
built-in `anthropic` and `openai-codex` providers.

Pi has one OAuth slot per provider id. This extension creates named provider aliases.
Each alias reuses Pi's built-in OAuth flow and live model catalog, but stores
credentials separately.

Example result:

```text
anthropic-work/claude-opus-4-8
anthropic-personal/claude-sonnet-4-6
openai-codex-work/gpt-5.5
```

The active alias is also exposed to extension status integrations such as
`pi-powerline-footer` under the status key `sub-aliases`:

```text
claude-work · opus-4.8
codex-work · gpt-5.5
```

## Requirements

Pi 0.82.1 or newer. Nothing else — aliases reuse Pi's own built-in OAuth flows
and model catalog on a stock install.

## Install

```bash
pi install npm:pi-sub-aliases
```

For local development:

```bash
pi install /absolute/path/to/pi-sub-aliases
```

## Config

Create `~/.pi/agent/sub-aliases.json`:

```json
{
  "aliases": [
    { "slug": "work", "label": "Work", "handle": "claude-work" },
    { "slug": "personal", "label": "Personal", "handle": "claude-me" },
    { "provider": "openai-codex", "slug": "work", "label": "Codex Work" }
  ]
}
```

Optional project override (merged over global config in trusted projects):

```text
.pi/sub-aliases.json
```

Rules:

- `provider` is `"anthropic"` (default) or `"openai-codex"`
- `slug` creates the provider id: `anthropic-<slug>` or `openai-codex-<slug>`
- `label` is shown during OAuth login (defaults to the title-cased slug)
- `handle` is used by integrations such as `pi-fusion`; defaults to
  `claude-<slug>` or `codex-<slug>` per provider
- later entries with the same `(provider, slug)` replace earlier ones (this is
  how project config overrides global); the same slug may be reused across
  providers
- handles must be unique across global and project config files

Model metadata (context window, max tokens, cost) is always cloned from Pi's live
model registry at startup — never hardcoded, no config overrides.

## Use

Login once per alias:

```text
/login anthropic-work
/login openai-codex-work
```

Select models normally:

```text
/model anthropic-work/claude-opus-4-8
/model openai-codex-work/gpt-5.5
```

`pi-fusion` can use handles as shorthand:

```json
{ "model": "claude-work/opus-4.8" }
```

For `openai-codex` aliases the extension also keeps the Codex environment
(`OPENAI_CODEX_*`, `CHATGPT_ACCOUNT_ID`) in sync with the selected alias account, so
`pi-sub-bar` tracks the active subscription.

## Migration

### From pi-claude-alias

- Package renamed: replace `npm:pi-claude-alias` with `npm:pi-sub-aliases` in
  `~/.pi/agent/settings.json`.
- Config file renamed: move `~/.pi/agent/claude-alias.json` to
  `~/.pi/agent/sub-aliases.json` (same schema; `provider` is optional and defaults
  to `anthropic`). There is no legacy fallback.
- Footer status key renamed: `claude-alias` → `sub-aliases`.
- Provider ids are unchanged (`anthropic-<slug>`), so stored OAuth credentials and
  `model-router.json` patterns keep working — no re-login needed.

### From @carlosgtrz/pi-codex-aliases

- Replace `npm:@carlosgtrz/pi-codex-aliases` with `npm:pi-sub-aliases` and declare
  your Codex accounts in `sub-aliases.json` with `"provider": "openai-codex"`.
- Provider ids are unchanged (`openai-codex-<slug>`), so stored OAuth credentials
  keep working — no re-login needed.
- Model metadata is cloned live from Pi's registry, so alias models no longer drift
  from the built-in catalog.

## Non-goals

No proxy. No router. No failover. No quota logic. Just separate OAuth slots with
useful names.

## Attribution

The Codex stream wrapper (`src/codex-stream.ts`) and Codex env sync
(`src/codex-env.ts`) are derived from
[CarlosGtrz/carlosgtrz-pi-extensions](https://github.com/CarlosGtrz/carlosgtrz-pi-extensions)
(MIT).
