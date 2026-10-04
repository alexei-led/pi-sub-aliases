import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  TranscriptContext,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { getCodexAliasApi, wrapCodexStream } from "../src/codex-stream.js";
import type { AliasProviderConfig } from "../src/providers.js";
import { makeCodexModel } from "./support/models.js";

const ALIAS = { providerId: "openai-codex-work", label: "Codex Work" };
const ALIAS_API = "openai-codex-work-responses";

test("derives the per-alias custom api from the provider id", () => {
  assert.equal(getCodexAliasApi("openai-codex-work"), ALIAS_API);
});

test("rewrites the provider config and models to the alias api", () => {
  const wrapped = wrapCodexStream(makeAliasConfig(), ALIAS, {
    streamSimple: () => {
      throw new Error("not expected");
    },
  });

  assert.equal(wrapped.api, ALIAS_API);
  assert.equal(wrapped.models?.[0]?.api, ALIAS_API);
  assert.equal(typeof wrapped.streamSimple, "function");
  assert.equal(wrapped.baseUrl, "https://chatgpt.com/backend-api");
});

test("streams via the builtin codex provider and rewrites events back to the alias", async () => {
  const inner = createAssistantMessageEventStream();
  let captured:
    | {
        model: Model<Api>;
        context: TranscriptContext;
        options: SimpleStreamOptions | undefined;
      }
    | undefined;
  const wrapped = wrapCodexStream(makeAliasConfig(), ALIAS, {
    streamSimple(model, context, options) {
      captured = { model, context, options };
      return inner;
    },
  });

  const aliasModel: Model<Api> = {
    ...makeCodexModel(),
    provider: ALIAS.providerId,
    api: ALIAS_API,
  };
  const context = normalizeContext({
    messages: [
      { role: "user", content: "hello", timestamp: 1 },
      makeAssistantMessage(ALIAS.providerId, ALIAS_API),
      makeAssistantMessage("anthropic-work", "anthropic-messages"),
      // Real stored shape for another codex alias: alias provider name with
      // the builtin api (the inner stream stamps the api, we only rewrite
      // the provider on the way out).
      makeAssistantMessage("openai-codex-personal"),
      makeAssistantMessage(ALIAS.providerId, "openai-responses"),
      // Real stored shape for this alias.
      makeAssistantMessage(ALIAS.providerId),
      // Real stored shape for the stock builtin codex provider (session
      // started on stock codex, then switched to this alias).
      makeAssistantMessage("openai-codex"),
    ],
  });

  assert.ok(wrapped.streamSimple);
  const streamOptions: SimpleStreamOptions = {};
  const stream = wrapped.streamSimple(aliasModel, context, streamOptions);

  const innerPartial = makeAssistantMessage("openai-codex");
  const innerError = makeAssistantMessage("openai-codex");
  inner.push({ type: "start", partial: innerPartial });
  inner.push({
    type: "error",
    reason: "error",
    error: innerError,
  });

  const events = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.ok(captured);
  assert.equal(captured.model.provider, "openai-codex");
  assert.equal(captured.model.api, "openai-codex-responses");
  assert.equal(captured.model.id, aliasModel.id);
  // Options (carrying e.g. the abort signal) pass through untouched.
  assert.equal(captured.options, streamOptions);

  const replayed = captured.context.messages[1];
  assert.ok(replayed && replayed.role === "assistant");
  assert.equal(replayed.provider, "openai-codex");
  assert.equal(replayed.api, "openai-codex-responses");

  const foreign = captured.context.messages[2];
  assert.ok(foreign && foreign.role === "assistant");
  assert.equal(foreign.provider, "anthropic-work");
  assert.equal(foreign.api, "anthropic-messages");

  // Messages from another codex alias stay untouched (mid-session switch):
  // pi-ai treats them as cross-provider instead of replaying that account's
  // encrypted reasoning under this alias's token.
  const otherAlias = captured.context.messages[3];
  assert.ok(otherAlias && otherAlias.role === "assistant");
  assert.equal(otherAlias.provider, "openai-codex-personal");
  assert.equal(otherAlias.api, "openai-codex-responses");

  // A same-alias message with a foreign api keeps that api.
  const foreignApi = captured.context.messages[4];
  assert.ok(foreignApi && foreignApi.role === "assistant");
  assert.equal(foreignApi.provider, "openai-codex");
  assert.equal(foreignApi.api, "openai-responses");

  // The real stored same-alias shape (builtin api) becomes fully builtin.
  const stored = captured.context.messages[5];
  assert.ok(stored && stored.role === "assistant");
  assert.equal(stored.provider, "openai-codex");
  assert.equal(stored.api, "openai-codex-responses");

  // Stock-provider messages must not pass pi-ai's same-model check inside
  // the inner handler (provider/api/model would all match the rewritten
  // builtin model), or the stock account's encrypted reasoning would be
  // replayed under this alias's token. They are remapped off the builtin
  // provider so pi-ai takes its cross-provider path.
  const stock = captured.context.messages[6];
  assert.ok(stock && stock.role === "assistant");
  assert.notEqual(stock.provider, "openai-codex");
  assert.notEqual(stock.provider, ALIAS.providerId);
  assert.equal(stock.api, "openai-codex-responses");
  const originalStock = context.messages[6];
  assert.ok(originalStock && originalStock.role === "assistant");
  assert.equal(originalStock.provider, "openai-codex");

  const original = context.messages[1];
  assert.ok(original && original.role === "assistant");
  assert.equal(original.provider, ALIAS.providerId);

  assert.equal(events.length, 2);
  const [startEvent, errorEvent] = events;
  assert.ok(startEvent && startEvent.type === "start");
  assert.equal(startEvent.partial.provider, ALIAS.providerId);
  assert.ok(errorEvent && errorEvent.type === "error");
  assert.equal(errorEvent.error.provider, ALIAS.providerId);

  // The inner handler's accumulator objects must stay on the builtin
  // provider: it re-serializes them for its WebSocket continuation cache,
  // and an alias provider there would defeat cached-context continuation.
  assert.equal(innerPartial.provider, "openai-codex");
  assert.equal(innerError.provider, "openai-codex");
  assert.notEqual(startEvent.partial, innerPartial);
  assert.notEqual(errorEvent.error, innerError);
});

test("preserves normalized system tools and abort options across alias replay", async () => {
  const inner = createAssistantMessageEventStream();
  const controller = new AbortController();
  const tools = [{
    name: "lookup",
    description: "Lookup",
    parameters: { type: "object", properties: {} },
  }];
  const context = normalizeContext({
    systemPrompt: "Test instruction",
    tools,
    messages: [makeAssistantMessage(ALIAS.providerId, ALIAS_API)],
  });
  const wrapped = wrapCodexStream(makeAliasConfig(), ALIAS, {
    streamSimple(_model, transcript, options) {
      assert.equal(getCurrentSystemPrompt(transcript.messages), "Test instruction");
      assert.deepEqual(getCurrentTools(transcript.messages), tools);
      assert.equal(options?.signal, controller.signal);
      return inner;
    },
  });

  assert.ok(wrapped.streamSimple);
  const outer = wrapped.streamSimple(
    { ...makeCodexModel(), provider: ALIAS.providerId, api: ALIAS_API },
    context,
    { signal: controller.signal },
  );
  inner.push({
    type: "done",
    reason: "stop",
    message: makeAssistantMessage("openai-codex"),
  });
  assert.equal((await outer.result()).provider, ALIAS.providerId);
  const original = context.messages.at(-1);
  assert.ok(original?.role === "assistant");
  assert.equal(original.provider, ALIAS.providerId);
});

test("forwards the done event with the alias provider", async () => {
  const inner = createAssistantMessageEventStream();
  const wrapped = wrapCodexStream(makeAliasConfig(), ALIAS, {
    streamSimple: () => inner,
  });

  assert.ok(wrapped.streamSimple);
  const stream = wrapped.streamSimple(
    { ...makeCodexModel(), provider: ALIAS.providerId, api: ALIAS_API },
    normalizeContext({ messages: [] }),
  );

  const innerMessage = makeAssistantMessage("openai-codex");
  inner.push({
    type: "done",
    reason: "stop",
    message: innerMessage,
  });

  const message = await stream.result();
  assert.equal(message.provider, ALIAS.providerId);
  // The inner accumulator is not mutated (WebSocket continuation cache).
  assert.equal(innerMessage.provider, "openai-codex");
  assert.notEqual(message, innerMessage);
});

test("terminates the outer stream with an error event when the inner stream fails", async () => {
  const failing = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "start",
        partial: makeAssistantMessage("openai-codex"),
      } as const;
      await Promise.resolve();
      throw new Error("network down");
    },
  } as unknown as AssistantMessageEventStream;
  const wrapped = wrapCodexStream(makeAliasConfig(), ALIAS, {
    streamSimple: () => failing,
  });

  assert.ok(wrapped.streamSimple);
  const stream = wrapped.streamSimple(
    { ...makeCodexModel(), provider: ALIAS.providerId, api: ALIAS_API },
    normalizeContext({ messages: [] }),
  );

  const events = [];
  for await (const event of stream) {
    events.push(event);
  }

  const last = events.at(-1);
  assert.ok(last && last.type === "error");
  assert.equal(last.error.provider, ALIAS.providerId);
  assert.equal(last.error.stopReason, "error");
  assert.match(last.error.errorMessage ?? "", /network down/);
});

test("keeps models undefined when the config has none", () => {
  const wrapped = wrapCodexStream(
    {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    },
    ALIAS,
    {
      streamSimple: () => {
        throw new Error("not expected");
      },
    },
  );

  assert.equal(wrapped.api, ALIAS_API);
  assert.equal(wrapped.models, undefined);
});

function makeAliasConfig(): AliasProviderConfig {
  return {
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    models: [makeCodexModel()],
  };
}

function makeAssistantMessage(
  provider: string,
  api = "openai-codex-responses",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api,
    provider,
    model: "gpt-5.5",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}
