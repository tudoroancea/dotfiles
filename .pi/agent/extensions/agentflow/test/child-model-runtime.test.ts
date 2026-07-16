import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildModelRuntime } from "../src/runtime/child-model-runtime.ts";

afterEach(() => vi.restoreAllMocks());

describe("ChildModelRuntime", () => {
  it("keeps registered providers and models.json synchronized", async () => {
    const runtime = {
      reloadConfig: vi.fn(async () => undefined),
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
    expect(runtime.reloadConfig).toHaveBeenCalledTimes(2);
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

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("custom", "parent-runtime-key");
    expect(runtime.getAuth).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("uses the child's shared persisted auth when the parent has no runtime override", async () => {
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

    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("custom");
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });
});
