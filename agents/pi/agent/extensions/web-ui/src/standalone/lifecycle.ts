export class DisposableSlot {
  private dispose: (() => void) | undefined;

  replace(dispose: () => void): void {
    this.clear();
    this.dispose = dispose;
  }

  clear(expected?: () => void): void {
    if (expected && this.dispose !== expected) return;
    this.dispose?.();
    this.dispose = undefined;
  }
}

export interface SessionRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeFactory<TContext, TRuntime extends SessionRuntime> = (
  context: TContext,
  isCurrent: () => boolean,
) => TRuntime;

export class SessionRuntimeLifecycle<TContext, TRuntime extends SessionRuntime> {
  private generation = 0;
  private runtime: TRuntime | undefined;
  private readyRuntime: TRuntime | undefined;

  constructor(private readonly createRuntime: RuntimeFactory<TContext, TRuntime>) {}

  get current(): TRuntime | undefined {
    return this.readyRuntime;
  }

  async replace(context: TContext): Promise<void> {
    const generation = ++this.generation;
    const previous = this.runtime;
    this.readyRuntime = undefined;
    let candidate!: TRuntime;
    const isCurrent = () => this.generation === generation && this.runtime === candidate;
    candidate = this.createRuntime(context, isCurrent);
    this.runtime = candidate;

    try {
      await previous?.close();
    } catch (error) {
      if (isCurrent()) this.runtime = undefined;
      await candidate.close();
      throw error;
    }
    if (!isCurrent()) {
      await candidate.close();
      return;
    }

    try {
      await candidate.start();
    } catch (error) {
      if (isCurrent()) this.runtime = undefined;
      await candidate.close();
      throw error;
    }
    if (isCurrent()) this.readyRuntime = candidate;
    else await candidate.close();
  }

  async shutdown(): Promise<void> {
    this.generation += 1;
    const active = this.runtime;
    this.runtime = undefined;
    this.readyRuntime = undefined;
    await active?.close();
  }
}
