import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  loadAliases,
  type AliasDefinition,
  type AliasLoadOptions,
  type AliasLoadResult,
} from "./config.js";
import { resolveBuiltinOAuth, type WrappedOAuthProvider } from "./oauth.js";
import {
  PROVIDER_NAMES,
  PROVIDER_SPECS,
  type AliasModel,
  type AliasProviderConfig,
  type EventBusLike,
  type ProviderName,
  type ProviderSpec,
  type SyncEnvModelRegistry,
} from "./providers.js";
import { errorMessage, isRecord } from "./shared.js";

const FOOTER_STATUS_KEY = "sub-aliases";
const CONFIG_ERROR_PREFIX = "sub-aliases config";

export type SubAliasesExtensionAPI = {
  registerProvider(name: string, config: AliasProviderConfig): void;
  unregisterProvider(name: string): void;
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  events: EventBusLike;
};
type RefreshContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "isProjectTrusted" | "model" | "modelRegistry" | "ui"
>;

export type SubAliasesDeps = {
  getModels(provider: ProviderName): readonly unknown[];
  getOAuthProvider(provider: ProviderName): WrappedOAuthProvider;
  loadAliases(options: AliasLoadOptions): AliasLoadResult;
};

const defaultDeps = (): SubAliasesDeps => ({
  getModels: (provider) => piAiCompat.getModels(provider),
  // Resolved per provider at alias registration time from pi's own built-in
  // provider table, so a pi upgrade cannot strip the OAuth flow out from under
  // the aliases.
  getOAuthProvider: (provider) =>
    resolveBuiltinOAuth(PROVIDER_SPECS[provider].builtin),
  loadAliases,
});

export default function subAliases(pi: ExtensionAPI): void {
  registerSubAliases(pi);
}

export function registerSubAliases(
  pi: SubAliasesExtensionAPI,
  deps: SubAliasesDeps = defaultDeps(),
): void {
  let activeAliases: AliasDefinition[] = [];
  let registeredProviderIds = new Set<string>();
  let lastRegistrationSignature: string | undefined;
  let registrationErrors: string[] = [];
  // Separate signatures per channel: an error warned to the console during the
  // headless activation refresh must still reach the UI on the first session.
  let notifiedErrorSignature = "";
  let warnedErrorSignature = "";
  let warnedInvalidContext = false;

  function refreshAliasProviders(
    ctx?: RefreshContext,
    allowSubBarRefresh = false,
  ): void {
    const loaded = deps.loadAliases({
      ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx ? { projectTrusted: ctx.isProjectTrusted() } : {}),
    });

    const aliases = loaded.aliases;
    const sourceModels = resolveSourceModels(aliases, deps, ctx?.modelRegistry);
    const signature = getRegistrationSignature(aliases, sourceModels);

    if (signature !== lastRegistrationSignature) {
      const synced = syncRegisteredProviders(
        pi,
        aliases,
        deps,
        sourceModels,
        registeredProviderIds,
      );
      registeredProviderIds = synced.providerIds;
      registrationErrors = synced.errors;
      activeAliases = aliases.filter((alias) =>
        synced.providerIds.has(alias.providerId),
      );
      lastRegistrationSignature = signature;
    }

    reportConfigErrors([...loaded.errors, ...registrationErrors], ctx);
    syncAliasStatus(ctx, activeAliases);
    if (ctx) {
      syncProviderEnv(pi, ctx, activeAliases, allowSubBarRefresh);
    }
  }

  function reportConfigErrors(
    errors: readonly string[],
    ctx: RefreshContext | undefined,
  ): void {
    const signature = errors.join("\n");
    const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    const message = `${CONFIG_ERROR_PREFIX}: ${errors[0] ?? ""}${suffix}`;

    if (ctx?.hasUI) {
      const changed = signature !== notifiedErrorSignature;
      notifiedErrorSignature = signature;
      if (signature && changed) ctx.ui.notify(message, "error");
      return;
    }

    const changed = signature !== warnedErrorSignature;
    warnedErrorSignature = signature;
    if (signature && changed) console.warn(message);
  }

  function toRefreshContext(ctx: unknown): RefreshContext | undefined {
    if (isRefreshContext(ctx)) return ctx;
    if (!warnedInvalidContext) {
      warnedInvalidContext = true;
      console.warn(
        "sub-aliases: unexpected event context shape; ignoring event",
      );
    }
    return undefined;
  }

  refreshAliasProviders();

  const refresh =
    (allowSubBarRefresh: boolean) => (_event: unknown, ctx: unknown) => {
      const refreshCtx = toRefreshContext(ctx);
      if (!refreshCtx) return;
      refreshAliasProviders(refreshCtx, allowSubBarRefresh);
    };

  pi.on("session_start", refresh(true));
  pi.on("model_select", refresh(true));
  // Sync-only: mid-run events should re-assert env without sub-bar churn.
  pi.on("before_agent_start", refresh(false));
  pi.on("turn_start", refresh(false));
  pi.on("session_shutdown", (_event, ctx: unknown) => {
    const shutdownCtx = toRefreshContext(ctx);
    if (shutdownCtx?.hasUI) {
      shutdownCtx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
    }
    for (const provider of PROVIDER_NAMES) {
      PROVIDER_SPECS[provider].restoreEnv?.();
    }
  });
}

export function resolveBuiltinModels(
  spec: ProviderSpec,
  deps: Pick<SubAliasesDeps, "getModels">,
  modelRegistry?: SyncEnvModelRegistry,
): AliasModel[] {
  const builtinModels = deps
    .getModels(spec.builtin)
    .filter((model): model is AliasModel => isModelForApi(model, spec.api));
  if (!modelRegistry) return builtinModels;

  return builtinModels.map((model) => {
    const override = modelRegistry.find(spec.builtin, model.id);
    return isModelForApi(override, spec.api) ? override : model;
  });
}

export function registerAlias(
  pi: SubAliasesExtensionAPI,
  alias: AliasDefinition,
  spec: ProviderSpec,
  oauthProvider: WrappedOAuthProvider,
  sourceModels: readonly AliasModel[],
): void {
  const config: AliasProviderConfig = {
    baseUrl: sourceModels[0]?.baseUrl ?? spec.fallbackBaseUrl,
    api: spec.api,
    models: sourceModels.map((model) => cloneAliasModel(model, alias.label)),
    oauth: {
      ...oauthProvider,
      name: getAliasOAuthName(oauthProvider.name, alias.label),
    },
  };
  pi.registerProvider(
    alias.providerId,
    spec.wrapStream ? spec.wrapStream(config, alias) : config,
  );
}

export function getAliasOAuthName(baseName: string, label: string): string {
  return `${baseName} - ${label}`;
}

export function getFooterStatusText(
  model: { provider: string; id: string } | undefined,
  aliases: readonly AliasDefinition[],
): string | undefined {
  if (!model) return undefined;

  const alias = aliases.find((item) => item.providerId === model.provider);
  if (!alias) return undefined;

  const label = PROVIDER_SPECS[alias.provider].footerLabel(model.id);
  return `${alias.handle} · ${label}`;
}

function resolveSourceModels(
  aliases: readonly AliasDefinition[],
  deps: Pick<SubAliasesDeps, "getModels">,
  modelRegistry?: SyncEnvModelRegistry,
): Map<ProviderName, AliasModel[]> {
  const byProvider = new Map<ProviderName, AliasModel[]>();

  for (const alias of aliases) {
    if (byProvider.has(alias.provider)) continue;
    byProvider.set(
      alias.provider,
      resolveBuiltinModels(PROVIDER_SPECS[alias.provider], deps, modelRegistry),
    );
  }

  return byProvider;
}

function syncRegisteredProviders(
  pi: SubAliasesExtensionAPI,
  aliases: readonly AliasDefinition[],
  deps: Pick<SubAliasesDeps, "getOAuthProvider">,
  sourceModels: ReadonlyMap<ProviderName, readonly AliasModel[]>,
  registeredProviderIds: ReadonlySet<string>,
): { providerIds: Set<string>; errors: string[] } {
  const nextProviderIds = new Set(aliases.map((alias) => alias.providerId));

  for (const providerId of registeredProviderIds) {
    if (!nextProviderIds.has(providerId)) {
      pi.unregisterProvider(providerId);
    }
  }

  const providerIds = new Set<string>();
  const errors: string[] = [];

  // Per-alias isolation: one provider's failure (e.g. a pi release that drops
  // its built-in OAuth flow) must not take down the other provider's aliases.
  for (const alias of aliases) {
    try {
      registerAlias(
        pi,
        alias,
        PROVIDER_SPECS[alias.provider],
        deps.getOAuthProvider(alias.provider),
        sourceModels.get(alias.provider) ?? [],
      );
      providerIds.add(alias.providerId);
    } catch (error) {
      errors.push(`${alias.providerId}: ${errorMessage(error)}`);
      // registerProvider replaces in place, so a failed re-registration can
      // leave the previous (stale-config) registration installed yet
      // untracked — the config-removal sweep above would never reclaim it.
      pi.unregisterProvider(alias.providerId);
    }
  }

  return { providerIds, errors };
}

function syncProviderEnv(
  pi: SubAliasesExtensionAPI,
  ctx: RefreshContext,
  aliases: readonly AliasDefinition[],
  allowSubBarRefresh: boolean,
): void {
  for (const provider of PROVIDER_NAMES) {
    const spec = PROVIDER_SPECS[provider];
    if (!spec.syncEnv) continue;

    const providerIds = new Set(
      aliases
        .filter((alias) => alias.provider === provider)
        .map((alias) => alias.providerId),
    );
    spec.syncEnv(ctx, {
      isAliasProvider: (providerId) => providerIds.has(providerId),
      ...(allowSubBarRefresh ? { events: pi.events } : {}),
    });
  }
}

function syncAliasStatus(
  ctx: RefreshContext | undefined,
  aliases: readonly AliasDefinition[],
): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(FOOTER_STATUS_KEY, getFooterStatusText(ctx.model, aliases));
}

function isModelForApi(value: unknown, api: string): value is AliasModel {
  return hasApi(value) && value.api === api;
}

function isRefreshContext(value: unknown): value is RefreshContext {
  return (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    typeof value.hasUI === "boolean" &&
    typeof value.isProjectTrusted === "function" &&
    isRecord(value.ui) &&
    typeof value.ui.setStatus === "function" &&
    typeof value.ui.notify === "function"
  );
}

function hasApi(value: unknown): value is { api: unknown } {
  return typeof value === "object" && value !== null && "api" in value;
}

function getRegistrationSignature(
  aliases: readonly AliasDefinition[],
  sourceModels: ReadonlyMap<ProviderName, readonly AliasModel[]>,
): string {
  return JSON.stringify({
    aliases: aliases.map((alias) => ({
      providerId: alias.providerId,
      handle: alias.handle,
      label: alias.label,
    })),
    // Serialize the models wholesale so a future pi Model field cannot be
    // silently excluded from change detection.
    models: PROVIDER_NAMES.map((provider) => sourceModels.get(provider) ?? []),
  });
}

function cloneAliasModel(model: AliasModel, label: string): AliasModel {
  const cloned = structuredClone(model);
  cloned.name = `${model.name} (${label})`;
  return cloned;
}
