import { describe, expect, it } from "vitest";
import { JobStore, MAX_JOB_NUMBER } from "../src/runtime/job-store.ts";

const input = {
  kind: "background_bash" as const,
  command: "sleep 1",
  cwd: "/tmp",
};

describe("JobStore", () => {
  it("allocates monotonic IDs across kinds and generations", () => {
    const store = new JobStore(() => "2026-01-01T00:00:00.000Z");
    const firstGeneration = store.beginGeneration();

    expect(store.create(firstGeneration, input)?.id).toBe("bg_1");
    expect(store.create(firstGeneration, { ...input, kind: "monitor" })?.id).toBe("mon_2");

    expect(store.endGeneration(firstGeneration)).toBe(true);
    const secondGeneration = store.beginGeneration();
    expect(store.create(secondGeneration, input)?.id).toBe("bg_3");
  });

  it("reserves the maximum safe-integer ID and rejects counter exhaustion clearly", () => {
    const store = new JobStore(() => "now");
    const generation = store.beginGeneration();
    (store as unknown as { nextJobNumber: number }).nextJobNumber = MAX_JOB_NUMBER;

    expect(store.create(generation, { ...input, kind: "monitor" })?.id).toBe(
      `mon_${MAX_JOB_NUMBER}`,
    );
    expect(() => store.create(generation, input)).toThrow(/ID counter exhausted.*new session/i);
  });

  it("uses strict first-writer-wins terminal transitions", () => {
    let tick = 0;
    const store = new JobStore(() => `time-${tick++}`);
    const generation = store.beginGeneration();
    const job = store.create(generation, input)!;

    expect(
      store.transitionTerminal(job.id, generation, {
        status: "timed_out",
        error: "deadline exceeded",
      }),
    ).toBe(true);
    expect(
      store.transitionTerminal(job.id, generation, {
        status: "completed",
        exitCode: 0,
      }),
    ).toBe(false);
    expect(store.get(job.id)).toMatchObject({
      status: "timed_out",
      error: "deadline exceeded",
      completedAt: "time-1",
    });
  });

  it("rejects stale generation creation and callbacks", () => {
    const store = new JobStore(() => "now");
    const staleGeneration = store.beginGeneration();
    const staleJob = store.create(staleGeneration, input)!;
    store.endGeneration(staleGeneration);

    const currentGeneration = store.beginGeneration();
    const currentJob = store.create(currentGeneration, input)!;

    expect(store.create(staleGeneration, input)).toBeUndefined();
    expect(store.transitionTerminal(currentJob.id, staleGeneration, { status: "failed" })).toBe(
      false,
    );
    expect(store.transitionTerminal(staleJob.id, staleGeneration, { status: "completed" })).toBe(
      false,
    );
    expect(store.get(currentJob.id)?.status).toBe("running");
    expect(store.get(staleJob.id)?.status).toBe("running");
  });

  it("invalidates callbacks after generation shutdown", () => {
    const store = new JobStore(() => "now");
    const generation = store.beginGeneration();
    const job = store.create(generation, input)!;

    expect(store.endGeneration(generation)).toBe(true);
    expect(store.endGeneration(generation)).toBe(false);
    expect(store.transitionTerminal(job.id, generation, { status: "cancelled" })).toBe(false);
    expect(store.get(job.id)?.status).toBe("running");
  });
});
