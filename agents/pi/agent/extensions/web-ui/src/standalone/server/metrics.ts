export type JournalMetric =
  | "frame_bytes"
  | "frame_count"
  | "serialization_ms"
  | "coalesced"
  | "reset"
  | "disconnect";

export interface JournalMetricsSink {
  record(metric: JournalMetric, value: number, reason?: string): void;
}

export interface JournalMetricsSnapshot {
  frameBytes: number;
  frameCount: number;
  serializationMs: number;
  coalesced: number;
  resets: number;
  disconnects: number;
}

export class JournalMetrics implements JournalMetricsSink {
  private readonly values: JournalMetricsSnapshot = {
    frameBytes: 0,
    frameCount: 0,
    serializationMs: 0,
    coalesced: 0,
    resets: 0,
    disconnects: 0,
  };

  constructor(private readonly downstream?: JournalMetricsSink) {}

  record(metric: JournalMetric, value: number, reason?: string): void {
    switch (metric) {
      case "frame_bytes":
        this.values.frameBytes += value;
        break;
      case "frame_count":
        this.values.frameCount += value;
        break;
      case "serialization_ms":
        this.values.serializationMs += value;
        break;
      case "coalesced":
        this.values.coalesced += value;
        break;
      case "reset":
        this.values.resets += value;
        break;
      case "disconnect":
        this.values.disconnects += value;
        break;
    }
    try {
      this.downstream?.record(metric, value, reason);
    } catch {
      // Metrics must never affect session delivery.
    }
  }

  snapshot(): JournalMetricsSnapshot {
    return { ...this.values };
  }
}
