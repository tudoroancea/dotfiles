import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";

type RegisteredProviderConfig = NonNullable<
  ReturnType<ModelRegistry["getRegisteredProviderConfig"]>
>;

export class ChildModelRuntime {
  private runtimePromise: Promise<ModelRuntime> | undefined;
  private syncChain: Promise<void> = Promise.resolve();
  private registeredProviderIds = new Set<string>();

  async get(parentRegistry: ModelRegistry): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false }).catch((error) => {
      this.runtimePromise = undefined;
      throw error;
    });
    const runtime = await this.runtimePromise;
    const sync = this.syncChain.then(() => this.sync(runtime, parentRegistry));
    this.syncChain = sync.catch(() => undefined);
    await sync;
    return runtime;
  }

  async ensureAuth(
    runtime: ModelRuntime,
    parentRegistry: ModelRegistry,
    model: Model<any> | undefined,
  ): Promise<void> {
    if (!model) return;
    const parentStatus = parentRegistry.getProviderAuthStatus(model.provider);
    if (parentStatus.source === "runtime") {
      const apiKey = await parentRegistry.getApiKeyForProvider(model.provider);
      if (apiKey) await runtime.setRuntimeApiKey(model.provider, apiKey);
      return;
    }

    await runtime.removeRuntimeApiKey(model.provider);
    if (await runtime.getAuth(model)) return;
    const apiKey = await parentRegistry.getApiKeyForProvider(model.provider);
    if (apiKey) await runtime.setRuntimeApiKey(model.provider, apiKey);
  }

  private async sync(runtime: ModelRuntime, parentRegistry: ModelRegistry): Promise<void> {
    await runtime.reloadConfig();
    const currentProviderIds = new Set(parentRegistry.getRegisteredProviderIds());
    for (const providerId of this.registeredProviderIds) {
      if (!currentProviderIds.has(providerId)) runtime.unregisterProvider(providerId);
    }
    for (const providerId of currentProviderIds) {
      const config = parentRegistry.getRegisteredProviderConfig(providerId);
      if (config)
        runtime.registerProvider(
          providerId,
          this.snapshotConfig(parentRegistry, providerId, config),
        );
    }
    this.registeredProviderIds = currentProviderIds;
    await runtime.refresh({ allowNetwork: false });
  }

  private snapshotConfig(
    parentRegistry: ModelRegistry,
    providerId: string,
    config: RegisteredProviderConfig,
  ): RegisteredProviderConfig {
    const models = parentRegistry
      .getAll()
      .filter((model) => model.provider === providerId)
      .map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        headers: model.headers,
        compat: model.compat,
      }));
    return {
      ...config,
      models: models.length > 0 ? models : config.models,
      refreshModels: undefined,
    };
  }
}
