// Codex alias stream wrapper. Ported from @carlosgtrz/pi-codex-aliases
// (https://github.com/CarlosGtrz/carlosgtrz-pi-extensions, MIT license).
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  TranscriptContext,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { AliasProviderConfig } from "./providers.js";
import { errorMessage } from "./shared.js";

const CODEX_BUILTIN_PROVIDER = "openai-codex";
const CODEX_BUILTIN_API = "openai-codex-responses";

export type CodexStreamDeps = {
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
};

const defaultDeps: CodexStreamDeps = { streamSimple };

export function getCodexAliasApi(providerId: string): string {
  return `${providerId}-responses`;
}

// Registers a per-alias custom api so pi routes streaming through our
// handler instead of the built-in Codex one.
export function wrapCodexStream(
  config: AliasProviderConfig,
  alias: { providerId: string; label: string },
  deps: CodexStreamDeps = defaultDeps,
): AliasProviderConfig {
  const api = getCodexAliasApi(alias.providerId);
  return {
    ...config,
    api,
    ...(config.models
      ? { models: config.models.map((model) => ({ ...model, api })) }
      : {}),
    streamSimple(model, context, options) {
      // pi resolves the alias OAuth token before calling this. The built-in
      // Codex stream has provider-name checks for tool-call/replay
      // compatibility, so run it with provider/api rewritten to the built-in
      // ones and rewrite the emitted events back to the alias provider.
      const codexModel: Model<Api> = {
        ...model,
        provider: CODEX_BUILTIN_PROVIDER,
        api: CODEX_BUILTIN_API,
      };

      const inner = deps.streamSimple(
        codexModel,
        rewriteContextToBuiltin(context, alias.providerId, api),
        options,
      );
      const outer = createAssistantMessageEventStream();

      void (async () => {
        try {
          for await (const event of inner) {
            outer.push(rewriteEventProvider(event, alias.providerId));
          }
        } catch (error) {
          // Terminate the outer stream instead of hanging the turn when the
          // inner iteration rejects without emitting an error event.
          outer.push(makeStreamErrorEvent(model, error));
        }
      })();

      return outer;
    },
  };
}

function makeStreamErrorEvent(
  model: Model<Api>,
  error: unknown,
): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: errorMessage(error),
      timestamp: Date.now(),
    },
  };
}

// The "#" keeps this out of the alias providerId space: providerIds are
// `openai-codex-<slug>` with slug charset [a-z0-9-]. The rewritten context
// is transient (never persisted), so the string only feeds pi-ai's
// same-model equality checks.
const CODEX_STOCK_SENTINEL_PROVIDER = "openai-codex#stock";

// Replayed assistant messages fall into three classes:
// - *This* alias: rewritten to the builtin provider/api so pi-ai treats
//   them as same-model and replays their encrypted reasoning.
// - *Other* codex aliases (mid-session alias switches): left untouched, so
//   pi-ai treats them as cross-provider — that account's encrypted
//   reasoning is dropped and tool-call ids are normalized.
// - The *stock* builtin openai-codex provider: remapped to a sentinel
//   provider. Stock messages already carry the builtin provider/api/model,
//   so left untouched they would pass pi-ai's same-model check inside the
//   inner handler and replay the stock account's encrypted reasoning under
//   this alias's token — risking API rejection and crossing the account
//   boundary the aliases exist for. The sentinel forces the same graceful
//   cross-provider path other aliases get.
function rewriteContextToBuiltin(
  context: TranscriptContext,
  providerId: string,
  aliasApi: string,
): TranscriptContext {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "assistant") return message;
      if (message.provider === providerId) {
        return {
          ...message,
          provider: CODEX_BUILTIN_PROVIDER,
          api: message.api === aliasApi ? CODEX_BUILTIN_API : message.api,
        };
      }
      if (message.provider === CODEX_BUILTIN_PROVIDER) {
        return { ...message, provider: CODEX_STOCK_SENTINEL_PROVIDER };
      }
      return message;
    }),
  };
}

// The inner codex handler pushes its own accumulator object by identity in
// every event (partial/message) and, on the WebSocket path, re-serializes
// that same object after the stream ends to build its cached-context
// continuation. Mutating it in place would flip the accumulator to the
// alias provider, making the handler classify its own response as
// cross-model — the continuation prefix never matches and the full context
// is resent every turn. Emit shallow copies instead; content arrays stay
// shared, which is fine because the outer copies are read-only downstream.
function rewriteEventProvider(
  event: AssistantMessageEvent,
  providerId: string,
): AssistantMessageEvent {
  const copy = { ...event } as AssistantMessageEvent & {
    partial?: AssistantMessage;
    message?: AssistantMessage;
    error?: AssistantMessage;
  };

  if (copy.partial) copy.partial = { ...copy.partial, provider: providerId };
  if (copy.message) copy.message = { ...copy.message, provider: providerId };
  if (copy.error) copy.error = { ...copy.error, provider: providerId };

  return copy;
}
