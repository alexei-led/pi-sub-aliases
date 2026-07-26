import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import subAliases, {
  getAliasOAuthName,
  getFooterStatusText,
  registerAlias,
  registerSubAliases,
  resolveBuiltinModels,
  type SubAliasesDeps,
} from "../src/index.js";
import type { AliasDefinition } from "../src/config.js";
import { CODEX_ENV_KEYS, SUB_BAR_ACTION_CHANNEL } from "../src/codex-env.js";
import type { WrappedOAuthProvider } from "../src/oauth.js";
import { PROVIDER_SPECS, claudeShortLabel } from "../src/providers.js";
import { FakePi, type FakeModelRegistry } from "./support/fake-pi.js";
import { makeCodexModel } from "./support/models.js";

type AnthropicModel = Model<"anthropic-messages">;

test("default entry point registers aliases with real deps against stock pi-ai", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-sub-aliases-agent-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  assert.equal(getAgentDir(), agentDir);
  writeFileSync(
    join(agentDir, "sub-aliases.json"),
    JSON.stringify({ aliases: [{ slug: "work" }] }),
    "utf8",
  );
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.join(" "));
  });

  const pi = new FakePi();
  subAliases(pi as unknown as ExtensionAPI);

  // End-to-end against the real pi-ai the extension ships against: the
  // built-in OAuth flow and model catalog resolve without any patched install.
  const provider = pi.providers.get("anthropic-work");
  assert.ok(provider, "anthropic-work was not registered");
  assert.ok(provider.oauth?.name.endsWith(" - Work"));
  assert.ok((provider.models?.length ?? 0) > 0, "no models projected");
  assert.ok(pi.handlers.has("session_start"));
  assert.ok(pi.handlers.has("session_shutdown"));
  assert.equal(warnings.join("\n"), "");
});

test("registers config-driven aliases with the expected provider ids and login names", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
    makeAlias({ slug: "labs", handle: "claude-labs", label: "Labs" }),
  ];

  registerSubAliases(pi, makeDeps({ aliases }));

  assert.deepEqual([...pi.providers.keys()].sort(), [
    "anthropic-labs",
    "anthropic-work",
  ]);
  assert.equal(
    pi.providers.get("anthropic-work")?.oauth?.name,
    "Anthropic (Claude Pro/Max) - Work",
  );
  assert.equal(
    pi.providers.get("anthropic-labs")?.oauth?.name,
    "Anthropic (Claude Pro/Max) - Labs",
  );
});

test("registers aliases for both providers with per-provider models and oauth", () => {
  const pi = new FakePi();
  const codexModel = makeCodexModel();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
    makeCodexAlias({ slug: "work", handle: "codex-work", label: "Codex Work" }),
  ];

  registerSubAliases(
    pi,
    makeDeps({
      aliases,
      getModels: (provider) =>
        provider === "anthropic" ? [makeModel()] : [codexModel],
    }),
  );

  assert.deepEqual([...pi.providers.keys()].sort(), [
    "anthropic-work",
    "openai-codex-work",
  ]);

  const codex = pi.providers.get("openai-codex-work");
  assert.ok(codex);
  // The codex stream wrapper re-registers the alias under a per-alias api.
  assert.equal(codex.api, "openai-codex-work-responses");
  assert.equal(typeof codex.streamSimple, "function");
  assert.equal(codex.oauth?.name, "ChatGPT (Codex) - Codex Work");
  const registeredCodexModel = codex.models?.[0];
  assert.ok(registeredCodexModel);
  assert.equal(registeredCodexModel.id, codexModel.id);
  assert.equal(registeredCodexModel.name, "GPT 5.5 (Codex Work)");
  assert.equal(registeredCodexModel.api, "openai-codex-work-responses");
  // Issue #1 regression: metadata mirrors the live registry, not hardcoded.
  assert.equal(registeredCodexModel.contextWindow, codexModel.contextWindow);
  assert.equal(registeredCodexModel.maxTokens, codexModel.maxTokens);
  assert.deepEqual(registeredCodexModel.cost, codexModel.cost);

  const anthropic = pi.providers.get("anthropic-work");
  assert.ok(anthropic);
  assert.equal(anthropic.api, "anthropic-messages");
  assert.equal(anthropic.oauth?.name, "Anthropic (Claude Pro/Max) - Work");
});

test("keeps healthy providers when another provider's oauth is unavailable", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
    makeCodexAlias({ slug: "work", handle: "codex-work", label: "Codex Work" }),
  ];
  const ctx = pi.createContext({
    model: { provider: "anthropic-work", id: "claude-opus-4-8" },
  });

  registerSubAliases(
    pi,
    makeDeps({
      aliases,
      getOAuthProvider: (provider) => {
        if (provider === "openai-codex") {
          throw new Error("no OAuth flow for built-in provider openai-codex");
        }
        return makeOAuthProvider("Anthropic (Claude Pro/Max)");
      },
    }),
  );

  // The healthy provider registered and event handlers attached.
  assert.deepEqual([...pi.providers.keys()], ["anthropic-work"]);
  assert.ok(pi.handlers.has("session_start"));

  // The failure surfaces in the UI and the healthy alias still works.
  pi.emit("session_start", ctx);
  assert.equal(ctx.ui.lastStatus("sub-aliases"), "claude-work · opus-4.8");
  assert.equal(ctx.ui.notifications.length, 1);
  assert.match(
    ctx.ui.notifications[0]?.message ?? "",
    /openai-codex-work: no OAuth flow for built-in provider openai-codex/,
  );
});

test("skips re-registration until config or model metadata changes", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  let model = makeModel();
  const ctx = pi.createContext();

  registerSubAliases(pi, makeDeps({ aliases, getModels: () => [model] }));
  assert.deepEqual(pi.registerCalls, ["anthropic-work"]);

  pi.emit("before_agent_start", ctx);
  pi.emit("session_start", ctx);
  assert.deepEqual(pi.registerCalls, ["anthropic-work"]);

  model = makeModel({ maxTokens: 32_000 });
  pi.emit("before_agent_start", ctx);
  assert.deepEqual(pi.registerCalls, ["anthropic-work", "anthropic-work"]);
});

test("copies source models and preserves metadata", () => {
  const pi = new FakePi();
  const alias = makeAlias({
    slug: "work",
    handle: "claude-work",
    label: "Work",
  });
  const sourceModel = makeModel({
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: "max" },
    headers: { "x-test": "1" },
    compat: { forceAdaptiveThinking: true, allowEmptySignature: true },
  });

  registerAlias(
    pi,
    alias,
    PROVIDER_SPECS.anthropic,
    makeOAuthProvider("Anthropic (Claude Pro/Max)"),
    [sourceModel],
  );

  const aliasModel = pi.providers.get(alias.providerId)?.models?.[0];
  assert.ok(aliasModel);
  assert.equal(aliasModel.id, sourceModel.id);
  assert.equal(aliasModel.name, "Claude Opus 4.8 (Work)");
  assert.equal(aliasModel.api, sourceModel.api);
  assert.equal(aliasModel.baseUrl, sourceModel.baseUrl);
  assert.equal(aliasModel.reasoning, sourceModel.reasoning);
  assert.deepEqual(aliasModel.input, sourceModel.input);
  assert.deepEqual(aliasModel.cost, sourceModel.cost);
  assert.equal(aliasModel.contextWindow, sourceModel.contextWindow);
  assert.equal(aliasModel.maxTokens, sourceModel.maxTokens);
  assert.deepEqual(aliasModel.thinkingLevelMap, sourceModel.thinkingLevelMap);
  assert.deepEqual(aliasModel.headers, sourceModel.headers);
  assert.deepEqual(aliasModel.compat, sourceModel.compat);

  assert.notStrictEqual(aliasModel.input, sourceModel.input);
  assert.notStrictEqual(aliasModel.cost, sourceModel.cost);
  assert.notStrictEqual(
    aliasModel.thinkingLevelMap,
    sourceModel.thinkingLevelMap,
  );
  assert.notStrictEqual(aliasModel.headers, sourceModel.headers);
  assert.notStrictEqual(aliasModel.compat, sourceModel.compat);
});

test("uses model registry overrides when refreshing source models", () => {
  const baseModel = makeModel({ id: "claude-sonnet-4-6", maxTokens: 64_000 });
  const overrideModel = makeModel({
    id: "claude-sonnet-4-6",
    maxTokens: 32_000,
    headers: { "x-override": "1" },
  });
  const modelRegistry: FakeModelRegistry = {
    find(provider, modelId) {
      return provider === "anthropic" && modelId === baseModel.id
        ? overrideModel
        : undefined;
    },
  };

  const resolved = resolveBuiltinModels(
    PROVIDER_SPECS.anthropic,
    { getModels: () => [baseModel] },
    modelRegistry,
  );

  assert.deepEqual(resolved, [overrideModel]);
});

test("filters foreign-api models and ignores invalid registry overrides", () => {
  const baseModel = makeModel();
  const codexModel = makeCodexModel();
  const modelRegistry: FakeModelRegistry = {
    find: (provider, modelId) =>
      provider === "anthropic" && modelId === baseModel.id
        ? { id: baseModel.id, api: "openai-responses" }
        : undefined,
  };

  const resolved = resolveBuiltinModels(
    PROVIDER_SPECS.anthropic,
    { getModels: () => [baseModel, codexModel] },
    modelRegistry,
  );

  // The codex model is filtered out; the wrong-api override falls back to
  // the base model.
  assert.deepEqual(resolved, [baseModel]);
});

test("registers oauth-capable aliases even when the built-in catalog is empty", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];

  registerSubAliases(pi, makeDeps({ aliases, getModels: () => [] }));

  const work = pi.providers.get("anthropic-work");
  assert.ok(work);
  assert.deepEqual(work.models, []);
  assert.equal(work.baseUrl, "https://api.anthropic.com");
  assert.equal(work.oauth?.name, "Anthropic (Claude Pro/Max) - Work");
});

test("updates footer status with alias handle and short model name", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  const ctx = pi.createContext({
    model: { provider: "anthropic-work", id: "claude-opus-4-8" },
  });

  registerSubAliases(pi, makeDeps({ aliases }));
  pi.emit("session_start", ctx);

  assert.equal(ctx.ui.lastStatus("sub-aliases"), "claude-work · opus-4.8");
});

test("reports config errors once until the message changes", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  let errors: string[] = [];
  const ctx = pi.createContext({
    model: { provider: "anthropic-work", id: "claude-opus-4-8" },
  });

  registerSubAliases(
    pi,
    makeDeps({ loadAliases: () => ({ aliases, errors }) }),
  );

  errors = ["broken config"];
  pi.emit("session_start", ctx);
  assert.equal(ctx.ui.notifications.length, 1);

  pi.emit("before_agent_start", ctx);
  assert.equal(ctx.ui.notifications.length, 1);

  errors = ["still broken"];
  pi.emit("model_select", ctx);
  assert.equal(ctx.ui.notifications.length, 2);
  assert.equal(
    ctx.ui.notifications[1]?.message,
    "sub-aliases config: still broken",
  );

  // Multiple errors surface the first message plus a count.
  errors = ["still broken", "also broken"];
  pi.emit("model_select", ctx);
  assert.equal(ctx.ui.notifications.length, 3);
  assert.equal(
    ctx.ui.notifications[2]?.message,
    "sub-aliases config: still broken (+1 more)",
  );
});

test("notifies startup config errors on the first UI session", (t) => {
  t.mock.method(console, "warn", () => {});
  const pi = new FakePi();
  const ctx = pi.createContext();

  registerSubAliases(
    pi,
    makeDeps({ loadAliases: () => ({ aliases: [], errors: ["broken"] }) }),
  );

  // The activation refresh ran headless; the same error must still reach
  // the UI once a session starts.
  pi.emit("session_start", ctx);
  assert.equal(ctx.ui.notifications.length, 1);
  assert.equal(ctx.ui.notifications[0]?.message, "sub-aliases config: broken");

  pi.emit("model_select", ctx);
  assert.equal(ctx.ui.notifications.length, 1);
});

test("clears footer status on session shutdown", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  const ctx = pi.createContext({
    model: { provider: "anthropic-work", id: "claude-opus-4-8" },
  });

  registerSubAliases(pi, makeDeps({ aliases }));
  pi.emit("session_start", ctx);

  assert.equal(ctx.ui.lastStatus("sub-aliases"), "claude-work · opus-4.8");
  pi.emit("session_shutdown", ctx);
  assert.equal(ctx.ui.lastStatus("sub-aliases"), undefined);
});

test("unregisters stale providers when alias config changes", () => {
  const pi = new FakePi();
  let aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  const ctx = pi.createContext();

  registerSubAliases(
    pi,
    makeDeps({ loadAliases: () => ({ aliases, errors: [] }) }),
  );
  assert.ok(pi.providers.has("anthropic-work"));

  aliases = [];
  pi.emit("before_agent_start", ctx);

  assert.equal(pi.providers.has("anthropic-work"), false);
  assert.deepEqual(pi.unregisteredProviderIds, ["anthropic-work"]);
});

test("unregisters a previously registered alias when re-registration fails", () => {
  const pi = new FakePi();
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
  ];
  let model = makeModel();
  let oauthAvailable = true;
  const ctx = pi.createContext();

  registerSubAliases(
    pi,
    makeDeps({
      aliases,
      getModels: () => [model],
      getOAuthProvider: () => {
        if (!oauthAvailable) throw new Error("oauth export gone");
        return makeOAuthProvider("Anthropic (Claude Pro/Max)");
      },
    }),
  );
  assert.ok(pi.providers.has("anthropic-work"));

  // Force re-registration via a model metadata change while oauth is broken.
  model = makeModel({ maxTokens: 32_000 });
  oauthAvailable = false;
  pi.emit("before_agent_start", ctx);

  // The stale registration must not stay selectable with its old config.
  assert.equal(pi.providers.has("anthropic-work"), false);
  assert.deepEqual(pi.unregisteredProviderIds, ["anthropic-work"]);
  assert.match(
    ctx.ui.notifications[0]?.message ?? "",
    /anthropic-work: oauth export gone/,
  );
});

test("builds footer text only for active configured aliases", () => {
  const aliases = [
    makeAlias({ slug: "work", handle: "claude-work", label: "Work" }),
    makeCodexAlias({ slug: "work", handle: "codex-work", label: "Codex Work" }),
  ];

  assert.equal(
    getFooterStatusText(
      { provider: "anthropic-work", id: "claude-opus-4-5-20251101" },
      aliases,
    ),
    "claude-work · opus-4.5@20251101",
  );
  assert.equal(
    getFooterStatusText(
      { provider: "openai-codex-work", id: "gpt-5.5" },
      aliases,
    ),
    "codex-work · gpt-5.5",
  );
  assert.equal(
    getFooterStatusText(
      { provider: "anthropic", id: "claude-opus-4-8" },
      aliases,
    ),
    undefined,
  );
  assert.equal(getFooterStatusText(undefined, aliases), undefined);
});

test("syncs codex sub-bar env via the provider spec on model select", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const savedEnv = saveCodexEnv(t);
  const pi = new FakePi();
  const aliases = [
    makeCodexAlias({ slug: "work", handle: "codex-work", label: "Codex Work" }),
  ];
  const ctx = pi.createContext({
    model: { provider: "openai-codex-work", id: "gpt-5.5" },
    modelRegistry: makeCodexAuthRegistry(),
  });

  registerSubAliases(pi, makeDeps({ aliases }));
  pi.emit("model_select", ctx);

  assert.equal(process.env.OPENAI_CODEX_OAUTH_TOKEN, "codex-token");
  assert.equal(process.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");
  assert.equal(process.env.OPENAI_CODEX_ACCOUNT_ID, "acct-1");
  assert.equal(process.env.CHATGPT_ACCOUNT_ID, "acct-1");

  // model_select fires the sub-bar refresh (0ms + 250ms timers); advance the
  // mocked clock past the longest delay to drain both.
  t.mock.timers.tick(250);
  assert.equal(countSubBarRefreshes(pi), 2);

  // Sync-only mid-run event: env re-asserted without sub-bar churn.
  pi.emit("before_agent_start", ctx);
  assert.equal(countSubBarRefreshes(pi), 2);

  pi.emit(
    "model_select",
    pi.createContext({
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    }),
  );

  for (const key of CODEX_ENV_KEYS) {
    assert.equal(process.env[key], savedEnv[key]);
  }
});

test("restores codex env on session shutdown", (t) => {
  const savedEnv = saveCodexEnv(t);
  const pi = new FakePi();
  const aliases = [
    makeCodexAlias({ slug: "work", handle: "codex-work", label: "Codex Work" }),
  ];
  const ctx = pi.createContext({
    model: { provider: "openai-codex-work", id: "gpt-5.5" },
    modelRegistry: makeCodexAuthRegistry(),
  });

  registerSubAliases(pi, makeDeps({ aliases }));
  // before_agent_start sets env without scheduling sub-bar timers.
  pi.emit("before_agent_start", ctx);
  assert.equal(process.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");

  pi.emit("session_shutdown", ctx);

  for (const key of CODEX_ENV_KEYS) {
    assert.equal(process.env[key], savedEnv[key]);
  }
  assert.equal(countSubBarRefreshes(pi), 0);
});

test("formats alias oauth labels and claude footer model labels", () => {
  assert.equal(
    getAliasOAuthName("Anthropic (Claude Pro/Max)", "Work"),
    "Anthropic (Claude Pro/Max) - Work",
  );
  assert.equal(claudeShortLabel("claude-opus-4-8"), "opus-4.8");
  assert.equal(claudeShortLabel("claude-opus-4-10"), "opus-4.10");
  assert.equal(
    claudeShortLabel("claude-opus-4-5-20251101"),
    "opus-4.5@20251101",
  );
  // Unknown formats fall back to the trimmed model id.
  assert.equal(claudeShortLabel("claude-3-7-sonnet-x"), "3-7-sonnet-x");
  assert.equal(claudeShortLabel("gpt-5.5"), "gpt-5.5");
});

function saveCodexEnv(t: {
  after(callback: () => void): void;
}): Record<string, string | undefined> {
  const savedEnv = Object.fromEntries(
    CODEX_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const key of CODEX_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return savedEnv;
}

function makeCodexAuthRegistry(): FakeModelRegistry {
  return {
    find: () => undefined,
    authStorage: {
      get: (providerId) =>
        providerId === "openai-codex-work"
          ? {
              type: "oauth",
              access: "codex-token",
              expires: Date.now() + 3_600_000,
              accountId: "acct-1",
            }
          : undefined,
    },
  };
}

function countSubBarRefreshes(pi: FakePi): number {
  return pi.emittedEvents.filter(
    (event) => event.channel === SUB_BAR_ACTION_CHANNEL,
  ).length;
}

function makeDeps(overrides: {
  aliases?: AliasDefinition[];
  getModels?: SubAliasesDeps["getModels"];
  getOAuthProvider?: SubAliasesDeps["getOAuthProvider"];
  loadAliases?: SubAliasesDeps["loadAliases"];
}): SubAliasesDeps {
  return {
    getModels: overrides.getModels ?? (() => [makeModel()]),
    getOAuthProvider:
      overrides.getOAuthProvider ??
      ((provider) =>
        makeOAuthProvider(
          provider === "anthropic"
            ? "Anthropic (Claude Pro/Max)"
            : "ChatGPT (Codex)",
        )),
    loadAliases:
      overrides.loadAliases ??
      (() => ({ aliases: overrides.aliases ?? [], errors: [] })),
  };
}

function makeAlias(overrides: Partial<AliasDefinition>): AliasDefinition {
  const slug = overrides.slug ?? "work";
  return {
    provider: "anthropic",
    slug,
    providerId: `anthropic-${slug}`,
    handle: `claude-${slug}`,
    label: "Work",
    ...overrides,
  };
}

function makeCodexAlias(overrides: Partial<AliasDefinition>): AliasDefinition {
  const slug = overrides.slug ?? "work";
  return {
    provider: "openai-codex",
    slug,
    providerId: `openai-codex-${slug}`,
    handle: `codex-${slug}`,
    label: "Codex Work",
    ...overrides,
  };
}

function makeModel(overrides: Partial<AnthropicModel> = {}): AnthropicModel {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevelMap: { xhigh: "max" },
    ...overrides,
  };
}

function makeOAuthProvider(name: string): WrappedOAuthProvider {
  return {
    name,
    login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      return Promise.resolve({
        refresh: "refresh-token",
        access: "access-token",
        expires: 4_102_444_800_000,
      });
    },
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      return Promise.resolve(credentials);
    },
    getApiKey(credentials: OAuthCredentials): string {
      return String(credentials.access);
    },
  };
}
