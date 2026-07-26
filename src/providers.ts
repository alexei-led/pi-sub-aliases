import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { createCodexEnvSync } from "./codex-env.js";
import { wrapCodexStream } from "./codex-stream.js";

export const PROVIDER_NAMES = ["anthropic", "openai-codex"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type AliasModel = Model<Api>;

export type AliasProviderConfig = Parameters<
  ExtensionAPI["registerProvider"]
>[1];

export type WrapStreamHook = (
  config: AliasProviderConfig,
  alias: { providerId: string; label: string },
) => AliasProviderConfig;

export type EventBusLike = {
  emit(channel: string, data: unknown): void;
};

// `authStorage` is an undocumented pi internal, absent from the stock
// ModelRegistry type and so far absent at runtime; codex-env falls back to
// auth.json. `find` is not consumed here but is load-bearing: without a
// required member the type is "weak" and TS rejects assigning the real
// ModelRegistry to it (TS2559: no properties in common).
export type SyncEnvModelRegistry = {
  find(provider: string, modelId: string): unknown;
  authStorage?: { get(providerId: string): unknown } | undefined;
};

export type SyncEnvContext = {
  model?: { provider: string; id: string } | undefined;
  modelRegistry?: SyncEnvModelRegistry | undefined;
};

export type SyncEnvOptions = {
  isAliasProvider(providerId: string): boolean;
  /** Present when the triggering event may refresh the sub-bar. */
  events?: EventBusLike | undefined;
};

export type SyncEnvHook = (
  ctx: SyncEnvContext,
  options: SyncEnvOptions,
) => void;

export type ProviderSpec = {
  builtin: ProviderName;
  api: Api;
  fallbackBaseUrl: string;
  handlePrefix: string;
  footerLabel(modelId: string): string;
  wrapStream?: WrapStreamHook;
  syncEnv?: SyncEnvHook;
  restoreEnv?: () => void;
};

const codexEnv = createCodexEnvSync();

export const PROVIDER_SPECS: Record<ProviderName, ProviderSpec> = {
  anthropic: {
    builtin: "anthropic",
    api: "anthropic-messages",
    fallbackBaseUrl: "https://api.anthropic.com",
    handlePrefix: "claude",
    footerLabel: claudeShortLabel,
  },
  "openai-codex": {
    builtin: "openai-codex",
    api: "openai-codex-responses",
    fallbackBaseUrl: "https://chatgpt.com/backend-api",
    handlePrefix: "codex",
    // Codex model ids (gpt-5.5, ...) are short already.
    footerLabel: (modelId) => modelId,
    wrapStream: wrapCodexStream,
    syncEnv: codexEnv.sync,
    restoreEnv: codexEnv.restore,
  },
};

export function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export function claudeShortLabel(modelId: string): string {
  const trimmed = modelId.startsWith("claude-") ? modelId.slice(7) : modelId;
  const match = trimmed.match(
    /^(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-(\d{8}))?$/i,
  );
  if (!match) return trimmed;

  const [, family, major, minor, stamp] = match;
  if (!family || !major || !minor) return trimmed;

  const short = `${family.toLowerCase()}-${major}.${minor}`;
  return stamp ? `${short}@${stamp}` : short;
}
