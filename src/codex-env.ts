// Codex sub-bar env sync. Ported from @carlosgtrz/pi-codex-aliases
// (https://github.com/CarlosGtrz/carlosgtrz-pi-extensions, MIT license).
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { SyncEnvContext, SyncEnvOptions } from "./providers.js";
import { isRecord } from "./shared.js";

const OAUTH_TOKEN_ENV = "OPENAI_CODEX_OAUTH_TOKEN";
const ACCESS_TOKEN_ENV = "OPENAI_CODEX_ACCESS_TOKEN";
const ACCOUNT_ID_ENV = "OPENAI_CODEX_ACCOUNT_ID";
const CHATGPT_ACCOUNT_ID_ENV = "CHATGPT_ACCOUNT_ID";

export const CODEX_ENV_KEYS = [
  OAUTH_TOKEN_ENV,
  ACCESS_TOKEN_ENV,
  ACCOUNT_ID_ENV,
  CHATGPT_ACCOUNT_ID_ENV,
] as const;

export const SUB_BAR_ACTION_CHANNEL = "sub-core:action";
// Immediate + delayed refresh mirrors upstream: the sub-bar may read the env
// slightly after model_select fires.
const SUB_BAR_REFRESH_DELAYS_MS = [0, 250] as const;

type CodexEnvKey = (typeof CODEX_ENV_KEYS)[number];

export type CodexEnvSync = {
  sync: (ctx: SyncEnvContext, options: SyncEnvOptions) => void;
  restore: () => void;
};

export function createCodexEnvSync(
  env: Record<string, string | undefined> = process.env,
  schedule: (fn: () => void, delayMs: number) => void = (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
  // pi does not expose modelRegistry.authStorage to extensions, so that path is
  // a forward-compat probe; auth.json (via pi's public readStoredCredential) is
  // the working credential source.
  readCredential: (providerId: string) => unknown = (providerId) =>
    readStoredCredential(providerId),
): CodexEnvSync {
  const originalEnv = new Map<CodexEnvKey, string | undefined>(
    CODEX_ENV_KEYS.map((key) => [key, env[key]]),
  );
  let ownsEnv = false;

  function restoreEnv(): boolean {
    if (!ownsEnv) return false;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    ownsEnv = false;
    return true;
  }

  function applyEnv(ctx: SyncEnvContext, options: SyncEnvOptions): boolean {
    const provider = ctx.model?.provider;
    if (provider === undefined || !options.isAliasProvider(provider)) {
      return restoreEnv();
    }

    const credentials = getStoredOAuthCredentials(
      ctx,
      provider,
      readCredential,
    );
    if (!credentials) return restoreEnv();

    env[OAUTH_TOKEN_ENV] = credentials.access;
    env[ACCESS_TOKEN_ENV] = credentials.access;
    if (credentials.accountId === undefined) {
      delete env[ACCOUNT_ID_ENV];
      delete env[CHATGPT_ACCOUNT_ID_ENV];
    } else {
      env[ACCOUNT_ID_ENV] = credentials.accountId;
      env[CHATGPT_ACCOUNT_ID_ENV] = credentials.accountId;
    }
    ownsEnv = true;
    return true;
  }

  return {
    sync(ctx, options) {
      const synced = applyEnv(ctx, options);
      const events = options.events;
      if (!synced || !events) return;
      for (const delayMs of SUB_BAR_REFRESH_DELAYS_MS) {
        schedule(() => {
          events.emit(SUB_BAR_ACTION_CHANNEL, { type: "refresh", force: true });
        }, delayMs);
      }
    },
    restore() {
      restoreEnv();
    },
  };
}

function getStoredOAuthCredentials(
  ctx: SyncEnvContext,
  providerId: string,
  readCredential: (providerId: string) => unknown,
): { access: string; accountId?: string } | undefined {
  const stored =
    ctx.modelRegistry?.authStorage?.get(providerId) ??
    readCredential(providerId);
  if (
    !isRecord(stored) ||
    stored.type !== "oauth" ||
    typeof stored.access !== "string" ||
    isExpired(stored.expires)
  ) {
    return undefined;
  }
  return {
    access: stored.access,
    ...(typeof stored.accountId === "string"
      ? { accountId: stored.accountId }
      : {}),
  };
}

// pi refreshes an expired OAuth credential only during request preparation
// (pi-ai Models.getAuth), so a raw auth.json read can see a stale access
// token. Mirror pi's gate (`Date.now() < expires` keeps the stored token) and
// withhold expired tokens instead of exporting them; the turn_start /
// before_agent_start re-syncs export the refreshed credential on the next
// event. A token that expires after export still goes stale until then —
// accepted: the sub-bar usage fetch just fails until the next re-sync.
function isExpired(expires: unknown): boolean {
  return typeof expires === "number" && expires <= Date.now();
}
