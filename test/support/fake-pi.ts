import type { SubAliasesExtensionAPI } from "../../src/index.js";

type CapturedProviderConfig = Parameters<
  SubAliasesExtensionAPI["registerProvider"]
>[1];
type Handler = (event: unknown, ctx: unknown) => unknown;

export interface FakeModelRegistry {
  getAll(): readonly unknown[];
  authStorage?: { get(providerId: string): unknown };
}

export interface FakeContext {
  cwd: string;
  hasUI: boolean;
  model?: { provider: string; id: string };
  modelRegistry?: FakeModelRegistry;
  isProjectTrusted(): boolean;
  ui: FakeUi;
}

export class FakePi implements SubAliasesExtensionAPI {
  readonly providers = new Map<string, CapturedProviderConfig>();
  readonly registerCalls: string[] = [];
  readonly unregisteredProviderIds: string[] = [];
  readonly handlers = new Map<string, Handler[]>();
  readonly emittedEvents: Array<{ channel: string; data: unknown }> = [];
  readonly events = {
    emit: (channel: string, data: unknown): void => {
      this.emittedEvents.push({ channel, data });
    },
  };

  registerProvider(providerId: string, config: CapturedProviderConfig): void {
    this.registerCalls.push(providerId);
    this.providers.set(providerId, config);
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.unregisteredProviderIds.push(providerId);
  }

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, ctx: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({}, ctx);
    }
  }

  createContext(overrides: Partial<FakeContext> = {}): FakeContext {
    return {
      cwd: "/project",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: new FakeUi(),
      ...overrides,
    };
  }
}

export class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  readonly notifications: Array<{
    message: string;
    type: "info" | "warning" | "error" | undefined;
  }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }

  lastStatus(key: string): string | undefined {
    return this.statuses.findLast((entry) => entry.key === key)?.text;
  }
}
