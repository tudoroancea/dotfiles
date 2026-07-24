import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildModelRuntime } from "../src/runtime/child-model-runtime.ts";

afterEach(() => vi.restoreAllMocks());

describe("ChildModelRuntime", () => {
  it("keeps registered providers and models.json synchronized", async () => {
    const runtime = {
      registerNativeProvider: vi.fn(),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    };
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as never);
    let providers = ["first"];
    const configs = new Map<string, object>([
      ["first", { baseUrl: "https://first.test", refreshModels: vi.fn() }],
    ]);
    const registry = {
      getRegisteredProviderIds: () => providers,
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: (providerId: string) => configs.get(providerId),
      getAll: () =>
        providers.map((provider) => ({
          provider,
          id: `${provider}-model`,
          name: `${provider} model`,
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        })),
    };
    const owner = new ChildModelRuntime();

    await owner.get(registry as never);
    providers = ["second"];
    configs.set("second", { baseUrl: "https://second.test" });
    await owner.get(registry as never);

    expect(ModelRuntime.create).toHaveBeenCalledOnce();
    expect(runtime.registerProvider).toHaveBeenCalledWith(
      "second",
      expect.objectContaining({
        models: [expect.objectContaining({ id: "second-model" })],
        refreshModels: undefined,
      }),
    );
    expect(runtime.unregisterProvider).toHaveBeenCalledWith("first");
    expect(runtime.refresh).toHaveBeenLastCalledWith({ allowNetwork: false });
  });

  it("synchronizes native providers and transitions them back to legacy configs", async () => {
    const runtime = {
      registerNativeProvider: vi.fn(),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    };
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as never);
    const provider = { id: "custom", name: "Custom" };
    let nativeProvider: object | undefined = provider;
    let config: object | undefined;
    const registry = {
      getRegisteredProviderIds: () => ["custom"],
      getRegisteredNativeProvider: () => nativeProvider,
      getRegisteredProviderConfig: () => config,
      getAll: () => [],
    };
    const owner = new ChildModelRuntime();

    await owner.get(registry as never);
    expect(runtime.registerNativeProvider).toHaveBeenCalledWith(provider);

    nativeProvider = undefined;
    config = { baseUrl: "https://custom.test" };
    await owner.get(registry as never);
    expect(runtime.registerProvider).toHaveBeenCalledWith("custom", config);
  });

  it("copies the parent's effective runtime API key even when child auth exists", async () => {
    const runtime = {
      getAuth: vi.fn(async () => ({ apiKey: "stored-child-key" })),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      setRuntimeApiKey: vi.fn(async () => undefined),
    };
    const registry = {
      getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
      getApiKeyForProvider: vi.fn(async () => "parent-runtime-key"),
    };

    await new ChildModelRuntime().ensureAuth(
      runtime as never,
      registry as never,
      { provider: "custom", id: "model" } as never,
    );

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("custom", "parent-runtime-key", {
      allowNetwork: false,
    });
    expect(runtime.getAuth).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("uses shared persisted auth without repeatedly clearing absent runtime overrides", async () => {
    const runtime = {
      getAuth: vi.fn(async () => ({ apiKey: "shared-stored-key" })),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      setRuntimeApiKey: vi.fn(async () => undefined),
    };
    const registry = {
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: vi.fn(async () => "parent-stored-key"),
    };

    await new ChildModelRuntime().ensureAuth(
      runtime as never,
      registry as never,
      { provider: "custom", id: "model" } as never,
    );

    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("copies fallback parent auth without enabling catalog network refresh", async () => {
    const runtime = {
      getAuth: vi.fn(async () => undefined),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      setRuntimeApiKey: vi.fn(async () => undefined),
    };
    const registry = {
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
      getApiKeyForProvider: vi.fn(async () => "parent-environment-key"),
    };

    await new ChildModelRuntime().ensureAuth(
      runtime as never,
      registry as never,
      { provider: "custom", id: "model" } as never,
    );

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("custom", "parent-environment-key", {
      allowNetwork: false,
    });
  });

  it("clears a child runtime override when the parent stops using one", async () => {
    const runtime = {
      getAuth: vi.fn(async () => ({ apiKey: "shared-stored-key" })),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      setRuntimeApiKey: vi.fn(async () => undefined),
    };
    let source = "runtime";
    const registry = {
      getProviderAuthStatus: () => ({ configured: true, source }),
      getApiKeyForProvider: vi.fn(async () => "parent-runtime-key"),
    };
    const owner = new ChildModelRuntime();
    const model = { provider: "custom", id: "model" } as never;

    await owner.ensureAuth(runtime as never, registry as never, model);
    source = "stored";
    await owner.ensureAuth(runtime as never, registry as never, model);

    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledOnce();
    expect(runtime.getAuth).toHaveBeenCalledOnce();
  });
});
