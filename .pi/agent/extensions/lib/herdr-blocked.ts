export interface ExtensionEventBus {
  emit(event: string, data: unknown): void;
}

export async function withHerdrBlocked<T>(
  events: ExtensionEventBus,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  events.emit("herdr:blocked", { active: true, label });
  try {
    return await operation();
  } finally {
    events.emit("herdr:blocked", { active: false });
  }
}
