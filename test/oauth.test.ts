import assert from "node:assert/strict";
import test from "node:test";
import type {
  OAuthAuth,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import { PROVIDER_NAMES } from "../src/providers.js";
import { adaptOAuth, resolveBuiltinOAuth } from "../src/oauth.js";

type OAuthCredential = Awaited<ReturnType<OAuthAuth["login"]>>;

const CREDENTIAL: OAuthCredential = {
  type: "oauth",
  refresh: "refresh-token",
  access: "access-token",
  expires: 4_102_444_800_000,
};

test("resolveBuiltinOAuth adapts every aliased provider's built-in flow", () => {
  // Guards the pi upgrade that removes a built-in OAuth flow, renames a
  // provider id, or drops the providers/all entrypoint.
  for (const provider of PROVIDER_NAMES) {
    const resolved = resolveBuiltinOAuth(provider);
    assert.ok(resolved.name.length > 0, `${provider} has no display name`);
    assert.equal(typeof resolved.login, "function");
    assert.equal(typeof resolved.refreshToken, "function");
    assert.equal(resolved.getApiKey(makeLegacyCredentials("tok")), "tok");
  }
});

test("resolveBuiltinOAuth rejects a provider with no built-in OAuth flow", () => {
  assert.throws(
    () => resolveBuiltinOAuth("not-a-provider"),
    /no OAuth flow for built-in provider not-a-provider/,
  );
});

test("adaptOAuth keeps the provider display name and derives the api key", () => {
  const adapted = adaptOAuth(makeFakeOAuth());
  assert.equal(adapted.name, "ChatGPT (Codex)");
  assert.equal(adapted.getApiKey(makeLegacyCredentials("token-1")), "token-1");
});

test("login routes notify events to the legacy callbacks", async () => {
  const { calls, callbacks } = makeCallbacks();
  const adapted = adaptOAuth(
    makeFakeOAuth((interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://login",
        instructions: "open it",
      });
      interaction.notify({ type: "auth_url", url: "https://bare" });
      interaction.notify({
        type: "device_code",
        userCode: "AB-12",
        verificationUri: "https://verify",
      });
      interaction.notify({ type: "progress", message: "working" });
      interaction.notify({ type: "info", message: "fyi" });
      return Promise.resolve(CREDENTIAL);
    }),
  );

  const credentials = await adapted.login(callbacks);

  assert.equal(credentials.access, CREDENTIAL.access);
  assert.deepEqual(calls.auth, [
    { url: "https://login", instructions: "open it" },
    { url: "https://bare" },
  ]);
  assert.deepEqual(calls.deviceCode, [
    {
      type: "device_code",
      userCode: "AB-12",
      verificationUri: "https://verify",
    },
  ]);
  assert.deepEqual(calls.progress, ["working", "fyi"]);
});

test("login routes prompts to manual code, select, and generic callbacks", async () => {
  const { calls, callbacks } = makeCallbacks();
  const answers: string[] = [];
  const adapted = adaptOAuth(
    makeFakeOAuth(async (interaction) => {
      answers.push(
        await interaction.prompt({ type: "manual_code", message: "paste" }),
      );
      answers.push(
        await interaction.prompt({
          type: "select",
          message: "pick account",
          options: [{ id: "acct-1", label: "One" }],
        }),
      );
      answers.push(
        await interaction.prompt({
          type: "text",
          message: "enter",
          placeholder: "hint",
        }),
      );
      return CREDENTIAL;
    }),
  );

  await adapted.login(callbacks);

  assert.deepEqual(answers, ["manual-code", "acct-1", "typed"]);
  assert.deepEqual(calls.selects, [
    { message: "pick account", options: [{ id: "acct-1", label: "One" }] },
  ]);
  assert.deepEqual(calls.prompts, [{ message: "enter", placeholder: "hint" }]);
});

test("login falls back to the generic prompt without a manual-code callback", async () => {
  const { calls, callbacks } = makeCallbacks();
  delete callbacks.onManualCodeInput;
  const adapted = adaptOAuth(
    makeFakeOAuth(async (interaction) => {
      await interaction.prompt({ type: "manual_code", message: "paste" });
      return CREDENTIAL;
    }),
  );

  await adapted.login(callbacks);

  assert.deepEqual(calls.prompts, [{ message: "paste" }]);
});

test("login resolves a cancelled select to an empty id", async () => {
  const { callbacks } = makeCallbacks({ selectResult: undefined });
  let answer: string | undefined;
  const adapted = adaptOAuth(
    makeFakeOAuth(async (interaction) => {
      answer = await interaction.prompt({
        type: "select",
        message: "pick",
        options: [],
      });
      return CREDENTIAL;
    }),
  );

  await adapted.login(callbacks);

  assert.equal(answer, "");
});

test("login forwards the abort signal when present", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const adapted = adaptOAuth(
    makeFakeOAuth((interaction) => {
      seenSignal = interaction.signal;
      return Promise.resolve(CREDENTIAL);
    }),
  );

  const { callbacks } = makeCallbacks();
  callbacks.signal = controller.signal;
  await adapted.login(callbacks);
  assert.equal(seenSignal, controller.signal);

  delete callbacks.signal;
  seenSignal = undefined;
  await adapted.login(callbacks);
  assert.equal(seenSignal, undefined);
});

test("refreshToken re-tags the stored credential as oauth", async () => {
  const received: OAuthCredential[] = [];
  const adapted = adaptOAuth(
    makeFakeOAuth(undefined, (credential) => {
      received.push(credential);
      return Promise.resolve({ ...credential, access: "new-access" });
    }),
  );

  const refreshed = await adapted.refreshToken(
    makeLegacyCredentials("old-access"),
  );

  const [stored] = received;
  assert.ok(stored);
  assert.equal(stored.type, "oauth");
  assert.equal(stored.access, "old-access");
  assert.equal(refreshed.access, "new-access");
});

function makeFakeOAuth(
  login?: OAuthAuth["login"],
  refresh?: OAuthAuth["refresh"],
): OAuthAuth {
  return {
    name: "ChatGPT (Codex)",
    login: login ?? (() => Promise.resolve(CREDENTIAL)),
    refresh: refresh ?? ((credential) => Promise.resolve(credential)),
    toAuth: () => Promise.reject(new Error("not used")),
  };
}

function makeLegacyCredentials(access: string): OAuthCredentials {
  return { refresh: "refresh-token", access, expires: 4_102_444_800_000 };
}

function makeCallbacks(options: { selectResult?: string | undefined } = {}) {
  const calls = {
    auth: [] as unknown[],
    deviceCode: [] as unknown[],
    progress: [] as string[],
    prompts: [] as unknown[],
    selects: [] as unknown[],
  };
  const selectResult =
    "selectResult" in options ? options.selectResult : "acct-1";
  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => {
      calls.auth.push(info);
    },
    onDeviceCode: (info) => {
      calls.deviceCode.push(info);
    },
    onProgress: (message) => {
      calls.progress.push(message);
    },
    onPrompt: (prompt) => {
      calls.prompts.push(prompt);
      return Promise.resolve("typed");
    },
    onManualCodeInput: () => Promise.resolve("manual-code"),
    onSelect: (prompt) => {
      calls.selects.push(prompt);
      return Promise.resolve(selectResult);
    },
  };
  return { calls, callbacks };
}
