import type {
  OAuthAuth,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type WrappedOAuthProvider = {
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
};

// builtinProviders() rebuilds every provider and its model catalog on each
// call; the built-in set is static for the process.
let builtins:
  readonly { id: string; auth?: { oauth?: OAuthAuth } }[] | undefined;

// Import via "providers/all": pi's extension loader maps it to the same pi-ai
// the agent itself runs, so aliases share pi's built-in OAuth flows rather than
// a second copy with its own credential state.
export function resolveBuiltinOAuth(providerId: string): WrappedOAuthProvider {
  builtins ??= builtinProviders();
  const oauth = builtins.find((provider) => provider.id === providerId)?.auth
    ?.oauth;
  if (!oauth) {
    throw new Error(
      `@earendil-works/pi-ai exposes no OAuth flow for built-in provider ${providerId}`,
    );
  }
  return adaptOAuth(oauth);
}

// pi's provider-composer expects callback-style login, refreshToken, and a
// synchronous getApiKey; the built-in flows expose login(interaction)/refresh/
// toAuth. Bridge the two.
export function adaptOAuth(oauth: OAuthAuth): WrappedOAuthProvider {
  return {
    name: oauth.name,
    login: (callbacks) =>
      oauth.login({
        ...(callbacks.signal ? { signal: callbacks.signal } : {}),
        notify: (event) => {
          switch (event.type) {
            case "auth_url":
              callbacks.onAuth({
                url: event.url,
                ...(event.instructions
                  ? { instructions: event.instructions }
                  : {}),
              });
              break;
            case "device_code":
              callbacks.onDeviceCode(event);
              break;
            default:
              callbacks.onProgress?.(event.message);
          }
        },
        prompt: (prompt) => {
          if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
            return callbacks.onManualCodeInput();
          }
          if (prompt.type === "select") {
            return callbacks
              .onSelect({
                message: prompt.message,
                options: prompt.options.map(({ id, label }) => ({ id, label })),
              })
              .then((choice) => choice ?? "");
          }
          return callbacks.onPrompt({
            message: prompt.message,
            ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
          });
        },
      }),
    refreshToken: (credentials) =>
      oauth.refresh({ ...credentials, type: "oauth" }),
    // toAuth() is async but pi needs a sync string; for both providers the
    // OAuth access token is the api key (mirrors pi's own extension docs).
    getApiKey: (credentials) => credentials.access,
  };
}
