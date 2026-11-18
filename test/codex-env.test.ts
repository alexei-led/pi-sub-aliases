import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_ENV_KEYS,
  SUB_BAR_ACTION_CHANNEL,
  createCodexEnvSync,
} from "../src/codex-env.js";
import type { SyncEnvContext } from "../src/providers.js";

const PROVIDER_ID = "openai-codex-work";
const REFRESH_ACTION = { type: "refresh", force: true };

function makeHarness(
  initialEnv: Record<string, string | undefined> = {},
  readCredential: (providerId: string) => unknown = () => undefined,
) {
  const env = { ...initialEnv };
  const scheduledDelays: number[] = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const syncer = createCodexEnvSync(
    env,
    (fn, delayMs) => {
      scheduledDelays.push(delayMs);
      fn();
    },
    readCredential,
  );
  return {
    env,
    scheduledDelays,
    emitted,
    syncer,
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
    },
    isAliasProvider: (providerId: string) => providerId === PROVIDER_ID,
  };
}

function makeCtx(credentials: unknown, provider = PROVIDER_ID): SyncEnvContext {
  return {
    model: { provider, id: "gpt-5.5" },
    modelRegistry: {
      getAll: () => [],
      authStorage: {
        get: (providerId) =>
          providerId === PROVIDER_ID ? credentials : undefined,
      },
    },
  };
}

function makeOAuthCredentials(accountId?: string): unknown {
  return {
    type: "oauth",
    access: "codex-token",
    expires: Date.now() + 3_600_000,
    ...(accountId === undefined ? {} : { accountId }),
  };
}

test("sets codex env vars and fires the sub-bar refresh for a selected alias", () => {
  const harness = makeHarness();

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), {
    isAliasProvider: harness.isAliasProvider,
    events: harness.events,
  });

  assert.equal(harness.env.OPENAI_CODEX_OAUTH_TOKEN, "codex-token");
  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");
  assert.equal(harness.env.OPENAI_CODEX_ACCOUNT_ID, "acct-1");
  assert.equal(harness.env.CHATGPT_ACCOUNT_ID, "acct-1");
  assert.deepEqual(harness.scheduledDelays, [0, 250]);
  assert.deepEqual(harness.emitted, [
    { channel: SUB_BAR_ACTION_CHANNEL, data: REFRESH_ACTION },
    { channel: SUB_BAR_ACTION_CHANNEL, data: REFRESH_ACTION },
  ]);
});

test("falls back to the stored credential file when authStorage is missing", () => {
  // pi 0.80 does not expose modelRegistry.authStorage; the credential must
  // come from the injected auth.json reader instead.
  // No expires field: tolerated (still exported) so an unexpected credential
  // shape cannot silently disable the sync.
  const harness = makeHarness({}, (providerId) =>
    providerId === PROVIDER_ID
      ? { type: "oauth", access: "file-token", accountId: "acct-file" }
      : undefined,
  );

  harness.syncer.sync(
    { model: { provider: PROVIDER_ID, id: "gpt-5.5" } },
    { isAliasProvider: harness.isAliasProvider, events: harness.events },
  );

  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "file-token");
  assert.equal(harness.env.CHATGPT_ACCOUNT_ID, "acct-file");
  assert.equal(harness.emitted.length, 2);
});

test("restores env when no model is selected", () => {
  const harness = makeHarness({ OPENAI_CODEX_ACCESS_TOKEN: "user-token" });
  const options = {
    isAliasProvider: harness.isAliasProvider,
    events: harness.events,
  };

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), options);
  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");

  harness.syncer.sync({ model: undefined }, options);

  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "user-token");
  assert.equal("CHATGPT_ACCOUNT_ID" in harness.env, false);
});

test("clears account id vars when the credential has no account id", () => {
  const harness = makeHarness();
  const options = {
    isAliasProvider: harness.isAliasProvider,
    events: harness.events,
  };

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), options);
  harness.syncer.sync(makeCtx(makeOAuthCredentials()), options);

  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");
  assert.equal("OPENAI_CODEX_ACCOUNT_ID" in harness.env, false);
  assert.equal("CHATGPT_ACCOUNT_ID" in harness.env, false);
});

test("restores the original env when a non-alias model is selected", () => {
  const harness = makeHarness({ OPENAI_CODEX_ACCESS_TOKEN: "user-token" });
  const options = {
    isAliasProvider: harness.isAliasProvider,
    events: harness.events,
  };

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), options);
  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");

  harness.syncer.sync(
    makeCtx(makeOAuthCredentials("acct-1"), "anthropic"),
    options,
  );

  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "user-token");
  assert.equal("OPENAI_CODEX_OAUTH_TOKEN" in harness.env, false);
  assert.equal("CHATGPT_ACCOUNT_ID" in harness.env, false);
  // Restoration also refreshes the sub-bar: two syncs, two emits each.
  assert.equal(harness.emitted.length, 4);
});

test("does not fire the sub-bar refresh on sync-only events", () => {
  const harness = makeHarness();

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), {
    isAliasProvider: harness.isAliasProvider,
  });

  assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "codex-token");
  assert.deepEqual(harness.emitted, []);
});

const NON_OAUTH_CREDENTIALS: Array<[string, unknown]> = [
  ["missing credential", undefined],
  ["non-oauth credential", { type: "apiKey", access: "key" }],
  ["credential without access token", { type: "oauth" }],
  // pi only refreshes during request prep; never export a known-stale token.
  [
    "stale credential",
    { type: "oauth", access: "stale-token", expires: Date.now() - 1 },
  ],
];

for (const [name, credentials] of NON_OAUTH_CREDENTIALS) {
  test(`leaves env untouched and skips refresh for a ${name}`, () => {
    const harness = makeHarness({ OPENAI_CODEX_ACCESS_TOKEN: "user-token" });

    harness.syncer.sync(makeCtx(credentials), {
      isAliasProvider: harness.isAliasProvider,
      events: harness.events,
    });

    assert.equal(harness.env.OPENAI_CODEX_ACCESS_TOKEN, "user-token");
    assert.equal("CHATGPT_ACCOUNT_ID" in harness.env, false);
    assert.deepEqual(harness.emitted, []);
  });
}

test("restore() puts the original env back after owning it", () => {
  const harness = makeHarness({ CHATGPT_ACCOUNT_ID: "user-acct" });

  harness.syncer.sync(makeCtx(makeOAuthCredentials("acct-1")), {
    isAliasProvider: harness.isAliasProvider,
  });
  assert.equal(harness.env.CHATGPT_ACCOUNT_ID, "acct-1");

  harness.syncer.restore();

  assert.equal(harness.env.CHATGPT_ACCOUNT_ID, "user-acct");
  for (const key of CODEX_ENV_KEYS) {
    if (key === "CHATGPT_ACCOUNT_ID") continue;
    assert.equal(key in harness.env, false);
  }
});
