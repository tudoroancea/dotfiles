import { projectJson, type JsonValue } from "./projection.js";

export const PROVIDER_DISCOVER_EVENT = "web-ui:provider-discover";
export const PROVIDER_REGISTER_EVENT = "web-ui:provider-register";

export interface DashboardProvider {
  id: "agentflow" | "background";
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  action(action: string, payload: unknown): Promise<unknown>;
}

export interface ProviderSnapshot {
  provider: DashboardProvider["id"];
  revision: number;
  data: JsonValue;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, DashboardProvider>();
  private readonly revisions = new Map<string, number>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<(snapshot: ProviderSnapshot) => void>();
  private readonly updateTimers = new Map<string, NodeJS.Timeout>();

  register(provider: DashboardProvider): void {
    if (provider.id !== "agentflow" && provider.id !== "background") return;
    this.unsubscribers.get(provider.id)?.();
    this.providers.set(provider.id, provider);
    this.revisions.set(provider.id, (this.revisions.get(provider.id) ?? -1) + 1);
    this.unsubscribers.set(
      provider.id,
      provider.subscribe(() => {
        const revision = (this.revisions.get(provider.id) ?? 0) + 1;
        this.revisions.set(provider.id, revision);
        if (this.updateTimers.has(provider.id)) return;
        const timer = setTimeout(() => {
          this.updateTimers.delete(provider.id);
          const snapshot = this.snapshot(provider.id);
          if (snapshot) for (const listener of this.listeners) listener(snapshot);
        }, 25);
        timer.unref?.();
        this.updateTimers.set(provider.id, timer);
      }),
    );
    const initial = this.snapshot(provider.id);
    if (initial) for (const listener of this.listeners) listener(initial);
  }

  list(): ProviderSnapshot[] {
    return [...this.providers.keys()].flatMap((id) => {
      const snapshot = this.snapshot(id);
      return snapshot ? [snapshot] : [];
    });
  }

  snapshot(id: string): ProviderSnapshot | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    return {
      provider: provider.id,
      revision: this.revisions.get(id) ?? 0,
      data: projectJson(provider.getSnapshot(), 1024 * 1024),
    };
  }

  async action(id: string, action: string, payload: unknown): Promise<JsonValue> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Dashboard provider unavailable: ${id}`);
    const result = await provider.action(action, projectJson(payload, 64 * 1024));
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    return projectJson(result, 1024 * 1024);
  }

  subscribe(listener: (snapshot: ProviderSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const timer of this.updateTimers.values()) clearTimeout(timer);
    this.updateTimers.clear();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.providers.clear();
    this.listeners.clear();
  }
}
