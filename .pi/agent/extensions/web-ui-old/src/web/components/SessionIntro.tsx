import type { SessionMetadata } from "../../shared/wire.js";
import { withHome } from "../lib/text.js";

function contextWindowLabel(metadata: SessionMetadata): string | undefined {
  const window = metadata.contextUsage?.contextWindow;
  if (!window || window <= 0) return undefined;
  if (window >= 1_000_000) return `${Math.round(window / 100_000) / 10}M context`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}K context`;
  return `${window} context`;
}

/**
 * The single in-flow session intro, modeled on the TUI startup banner. It is
 * the first thing in the transcript and scrolls away with it — no sticky bar.
 */
export function SessionIntro({
  metadata,
  sessionId,
}: {
  metadata?: SessionMetadata;
  sessionId?: string;
}) {
  const version = metadata?.piVersion;
  const model = metadata?.model;
  const cwd = metadata?.cwd ? withHome(metadata.cwd, metadata?.home) : undefined;
  const thinking = metadata?.thinkingLevel;
  const context = metadata ? contextWindowLabel(metadata) : undefined;
  const meta = [thinking ? `${thinking} thinking` : undefined, context].filter(Boolean).join(" · ");

  return (
    <section class="intro" aria-label="Session details">
      <div class="intro__mark" aria-hidden="true">
        π
      </div>
      <div class="intro__lines">
        <p class="intro__version">pi{version ? ` v${version}` : ""}</p>
        {model ? <p class="intro__model">{model.id}</p> : null}
        {cwd ? <p class="intro__cwd">{cwd}</p> : null}
        {meta ? <p class="intro__meta">{meta}</p> : null}
        {sessionId ? (
          <p class="intro__session" title={sessionId}>
            session {sessionId.slice(0, 8)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
