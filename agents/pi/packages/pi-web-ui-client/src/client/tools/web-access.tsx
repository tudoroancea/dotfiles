import { decodeWebAccessRendererView, type WebAccessRendererView } from "../../wire/web-access.ts";
import { pluralize, truncate } from "../format.ts";
import { Markdown } from "../markdown.tsx";
import {
  ExpandableOutput,
  Facts,
  ImageBlock,
  ResultNotice,
  StatusLine,
  Summary,
} from "./shared.tsx";
import {
  defineTool,
  flag,
  optionalNumber,
  optionalText,
  rawResult,
  requiredText,
  textList,
  type RegisteredTool,
  type ToolResultView,
} from "./types.ts";

function textSummary(result: ToolResultView, error: boolean) {
  const line =
    result.text.split("\n").find((value) => value.trim()) || (error ? "failed" : "no content");
  return (
    <Summary
      text={truncate(line.replaceAll(/\s+/g, " "), 160)}
      status={error ? "error" : undefined}
    />
  );
}

function Progress({ view, expanded }: { view: WebAccessRendererView; expanded: boolean }) {
  const progress = view.progress ?? 0;
  const percent = Math.round(progress * 100);
  const state =
    view.phase === "generating-summary"
      ? "generating summary draft"
      : view.phase === "waiting-for-approval"
        ? "summary ready; awaiting browser approval"
        : view.phase === "curating"
          ? "awaiting browser approval"
          : view.phase || "working";
  return (
    <>
      <StatusLine
        status="running"
        state={state}
        parts={[`${percent}%`, view.currentQuery || ""]}
        expanded={expanded}
      />
      <progress
        class="web-access-progress"
        max={1}
        value={progress}
        aria-label={`${state}: ${percent}%`}
      />
      {view.curatorGuidance ? <Summary text={view.curatorGuidance} /> : null}
      {view.phase !== "curator-fallback" &&
      (view.phase === "curating" ||
        view.phase === "generating-summary" ||
        view.phase === "waiting-for-approval") ? (
        <Summary
          text={[
            view.timeoutSeconds === undefined
              ? ""
              : `Auto-submits after ${view.timeoutSeconds}s idle`,
            `${view.shortcut || "session shortcut"} reopens`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : null}
      {view.curatorUrl ? (
        <div class="compact-result">
          <a href={view.curatorUrl} target="_blank" rel="noopener noreferrer">
            Open curator
          </a>
        </div>
      ) : null}
      {view.phase === "curator-fallback" ? (
        <Facts
          items={[
            { label: "Auto-open", value: view.diagnostics?.extraLines[0] || "failed", error: true },
            {
              label: "Idle timeout",
              value: view.timeoutSeconds === undefined ? "" : `${view.timeoutSeconds}s`,
            },
            { label: "Reopen", value: view.shortcut || "session shortcut" },
          ]}
        />
      ) : null}
    </>
  );
}

function Diagnostics({ view }: { view: WebAccessRendererView }) {
  const d = view.diagnostics;
  if (!d) return null;
  return (
    <>
      <Facts
        items={[
          { label: "Cancel reason", value: d.cancelReason || "" },
          {
            label: "Browser",
            value:
              d.browserConnected === undefined
                ? "unknown"
                : d.browserConnected
                  ? "connected"
                  : "never connected",
            error: d.browserConnected === false,
          },
          {
            label: "Last heartbeat",
            value:
              d.lastHeartbeatAgeMs === undefined
                ? ""
                : `${Math.round(d.lastHeartbeatAgeMs / 1000)}s ago`,
          },
          {
            label: "Queries",
            value:
              d.queryCount === undefined ? "" : `${d.queries.length}/${d.queryCount} completed`,
          },
        ]}
      />
      {d.queries.length ? (
        <ul>
          {d.queries.map((q, index) => (
            <li key={`${q.query}:${index}`}>
              {q.error ? "Error" : "OK"}: {q.query}
              {q.provider ? ` (${q.provider})` : ""} —{" "}
              {q.error || pluralize(q.resultCount, "source")}
            </li>
          ))}
        </ul>
      ) : null}
      {d.extraLines.length ? (
        <div class="tool-output error-output">
          {d.extraLines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function QueryResults({ view }: { view: WebAccessRendererView }) {
  return view.queries.length ? (
    <div>
      {view.queries.map((query, index) => (
        <section key={`${query.query}:${index}`}>
          <strong>{query.query}</strong>
          {query.provider ? ` · ${query.provider}` : ""}
          {query.error ? (
            <Summary text={query.error} status="error" />
          ) : query.answer ? (
            <Markdown text={query.answer} />
          ) : null}
          {query.sources.length ? (
            <ul>
              {query.sources.map((source, sourceIndex) => (
                <li key={`${source.url}:${sourceIndex}`}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    {source.title}
                  </a>{" "}
                  <span class="structured-muted">· {source.host}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      {view.omitted ? <Summary text={`${view.omitted} query records omitted`} /> : null}
    </div>
  ) : null;
}

function collapsedSummary(view: WebAccessRendererView, result: ToolResultView, error: boolean) {
  if (error) {
    const diagnostics = view.diagnostics;
    const completed = diagnostics?.queryCount
      ? ` · ${diagnostics.queries.length}/${diagnostics.queryCount} queries completed`
      : "";
    const reason =
      diagnostics?.browserConnected === false
        ? " · browser never connected"
        : diagnostics?.cancelReason
          ? ` · ${diagnostics.cancelReason}`
          : "";
    return (
      <Summary
        text={`${view.error || result.text.split("\n")[0] || "failed"}${completed}${reason}`}
        status="error"
      />
    );
  }
  if (view.tool === "web_search" && view.queryCount !== undefined) {
    const queryPart =
      view.queryCount === 1 ? "" : `${view.successfulQueries ?? 0}/${view.queryCount} queries · `;
    const curated =
      view.curated && view.curatedFrom
        ? ` · ${view.queryCount}/${view.curatedFrom} queries curated`
        : "";
    const fetch = view.fetchId
      ? view.fetchUrls.length
        ? ` · fetching ${pluralize(view.fetchUrls.length, "URL")}`
        : " · content ready"
      : "";
    return (
      <Summary
        text={`${queryPart}${pluralize(view.totalResults ?? 0, "source")}${curated}${fetch}`}
      />
    );
  }
  if (view.tool === "fetch_content" && view.urlCount !== undefined) {
    if (view.urlCount === 1) {
      const image = view.imageCount ? ` · ${pluralize(view.imageCount, "image")}` : "";
      return (
        <Summary
          text={`${view.title || "Untitled"} · ${view.totalChars ?? 0} chars${image}${view.truncated ? " · truncated" : ""}`}
        />
      );
    }
    return <Summary text={`${view.successful ?? 0}/${view.urlCount} URLs · content stored`} />;
  }
  if (view.tool === "get_search_content") {
    if (view.resultCount !== undefined)
      return <Summary text={pluralize(view.resultCount, "result")} />;
    if (view.returnedChars !== undefined)
      return (
        <Summary
          text={`${view.returnedChars}/${view.contentLength ?? view.returnedChars} chars${view.nextOffset !== null && view.nextOffset !== undefined ? " · more available" : ""}`}
        />
      );
  }
  if (view.tool === "source_check" && view.artifact)
    return (
      <Summary
        text={`${view.artifact.status || "checked"}${view.artifact.sources.length ? ` · ${pluralize(view.artifact.sources.length, "source")}` : ""}`}
      />
    );
  return textSummary(result, false);
}

function StructuredBody({
  view,
  result,
  expanded,
  dkey,
  images = false,
}: {
  view: WebAccessRendererView;
  result: ToolResultView;
  expanded: boolean;
  dkey: string;
  images?: boolean;
}) {
  const error = view.status === "failed" || view.status === "cancelled";
  if (view.status === "running") return <Progress view={view} expanded={expanded} />;
  return (
    <>
      {images ? <ImageBlock list={result.images} cls="tool-image" /> : null}
      {!expanded ? (
        collapsedSummary(view, result, error)
      ) : (
        <>
          <Facts
            items={[
              { label: "Status", value: view.status, error },
              { label: "Error", value: view.error || "", error: true },
              { label: "Title", value: view.title || "" },
              { label: "Images", value: view.imageCount ? String(view.imageCount) : "" },
              { label: "Truncated", value: view.truncated ? "yes" : "" },
              {
                label: "Duration",
                value: view.duration === undefined ? "" : `${view.duration}s`,
              },
              {
                label: "Queries",
                value:
                  view.queryCount === undefined
                    ? ""
                    : `${view.successfulQueries ?? 0}/${view.queryCount}`,
              },
              {
                label: "Sources",
                value: view.totalResults === undefined ? "" : String(view.totalResults),
              },
              {
                label: "URLs",
                value:
                  view.urlCount === undefined ? "" : `${view.successful ?? 0}/${view.urlCount}`,
              },
              {
                label: "Content",
                value:
                  view.returnedChars !== undefined
                    ? `${view.returnedChars}/${view.contentLength ?? view.returnedChars} chars`
                    : view.totalChars === undefined
                      ? ""
                      : `${view.totalChars} chars`,
              },
              { label: "Offset", value: view.offset === undefined ? "" : String(view.offset) },
              {
                label: "Next offset",
                value:
                  view.nextOffset === undefined || view.nextOffset === null
                    ? ""
                    : String(view.nextOffset),
              },
              { label: "Response", value: view.responseId || view.fetchId || "" },
            ]}
          />
          <Diagnostics view={view} />
          {view.fetchUrls.length ? (
            <Facts
              items={view.fetchUrls.map((url, index) => ({
                label: index ? "" : "URLs",
                value: url,
              }))}
            />
          ) : null}
          {view.summary ? (
            <>
              <Facts
                items={[
                  { label: "Summary", value: view.summary.workflow },
                  { label: "Model", value: view.summary.model || "deterministic" },
                  {
                    label: "Generation",
                    value: `${view.summary.durationMs}ms · ~${view.summary.tokenEstimate} tokens${view.summary.fallbackUsed ? " · fallback" : ""}${view.summary.edited ? " · edited" : ""}`,
                  },
                  { label: "Fallback reason", value: view.summary.fallbackReason || "" },
                ]}
              />
              <Markdown text={view.summary.text} />
            </>
          ) : null}
          <QueryResults view={view} />
          {view.artifact ? (
            <>
              <Facts
                items={[
                  { label: "Claim", value: view.artifact.claim },
                  { label: "Assessment", value: view.artifact.status || "" },
                  {
                    label: "Confidence",
                    value:
                      view.artifact.confidence === undefined
                        ? ""
                        : view.artifact.confidence.toFixed(2),
                  },
                  { label: "Rationale", value: view.artifact.rationale || "" },
                ]}
              />
              {view.artifact.supportingPassages.length ? (
                <Summary
                  text={`Supporting passages: ${view.artifact.supportingPassages.join(", ")}`}
                />
              ) : null}
              {view.artifact.contradictingPassages.length ? (
                <Summary
                  text={`Contradicting passages: ${view.artifact.contradictingPassages.join(", ")}`}
                  status="error"
                />
              ) : null}
              {view.artifact.sources.length ? (
                <ul>
                  {view.artifact.sources.map((source, index) => (
                    <li key={`${source.url}:${index}`}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.title}
                      </a>{" "}
                      · {source.quality}
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.artifact.errors.map((entry, index) => (
                <Summary key={index} text={`${entry.query}: ${entry.error}`} status="error" />
              ))}
              {view.responseId ? (
                <Summary
                  text={`Artifact ${view.responseId} is retrievable with get_search_content.`}
                />
              ) : null}
            </>
          ) : null}
          {view.notices.map((notice, index) => (
            <ResultNotice key={index} notice={notice} />
          ))}
          {!view.summary && !view.queries.length && !view.artifact && result.text ? (
            <ExpandableOutput
              text={result.text}
              maxLines={40}
              tone={error ? "error-output" : ""}
              dkey={`${dkey}:out`}
            />
          ) : null}
        </>
      )}
    </>
  );
}

const webSearch = defineTool({
  names: ["web_search"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw, result) => ({
    args: {
      queries: textList(raw.queries).length
        ? textList(raw.queries)
        : optionalText(raw.query)
          ? [optionalText(raw.query)]
          : [],
      numResults: optionalNumber(raw.numResults),
      provider: optionalText(raw.provider),
      recency: optionalText(raw.recencyFilter),
      domains: textList(raw.domainFilter),
      includeContent: flag(raw.includeContent),
    },
    view: decodeWebAccessRendererView("web_search", result ? rawResult(result) : undefined),
  }),
  header: ({ args }, { expanded }) => (
    <>
      <span class="tool-name">web_search</span>
      {args.queries.length ? (
        <span class="line-count">
          {" "}
          ·{" "}
          {expanded || args.queries.length === 1
            ? args.queries.join(" | ")
            : pluralize(args.queries.length, "query")}
        </span>
      ) : null}
      <span class="line-count">
        {[
          args.provider && args.provider !== "auto" ? args.provider : "",
          args.numResults === undefined ? "" : `${args.numResults} per query`,
          args.recency ? `past ${args.recency}` : "",
          args.domains.length ? args.domains.join(", ") : "",
          args.includeContent ? "with page content" : "",
        ]
          .filter(Boolean)
          .map((p) => ` · ${p}`)
          .join("")}
      </span>
    </>
  ),
  status: ({ view }) =>
    view.status === "running" ? "pending" : view.status === "completed" ? "success" : "error",
  body: ({ view }, result, ctx) =>
    !result ? null : (
      <StructuredBody view={view} result={result} expanded={ctx.expanded} dkey={ctx.dkey} />
    ),
});

const fetchContent = defineTool({
  names: ["fetch_content"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw, result) => {
    const urls = textList(raw.urls);
    const single = optionalText(raw.url);
    return {
      urls: urls.length ? urls : single ? [single] : [],
      prompt: optionalText(raw.prompt),
      timestamp: optionalText(raw.timestamp),
      frames: optionalNumber(raw.frames),
      model: optionalText(raw.model),
      view: decodeWebAccessRendererView("fetch_content", result ? rawResult(result) : undefined),
    };
  },
  header: (a, { expanded }) => (
    <>
      <span class="tool-name">fetch_content</span>
      {a.urls.length ? (
        <span class="tool-path">
          {" "}
          {expanded || a.urls.length === 1 ? a.urls.join(", ") : pluralize(a.urls.length, "URL")}
        </span>
      ) : null}
      <span class="line-count">
        {[
          a.timestamp ? `at ${a.timestamp}` : "",
          a.frames === undefined ? "" : pluralize(a.frames, "frame"),
          a.model,
        ]
          .filter(Boolean)
          .map((p) => ` · ${p}`)
          .join("")}
      </span>
      {a.prompt ? (
        <span class="line-count"> · {expanded ? a.prompt : truncate(a.prompt, 100)}</span>
      ) : null}
    </>
  ),
  status: (a) =>
    a.view.status === "running" ? "pending" : a.view.status === "completed" ? "success" : "error",
  body: (a, result, ctx) =>
    !result ? null : (
      <StructuredBody
        view={a.view}
        result={result}
        expanded={ctx.expanded}
        dkey={ctx.dkey}
        images
      />
    ),
});

const getSearchContent = defineTool({
  names: ["get_search_content"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw, result) => ({
    responseId: requiredText(raw.responseId),
    selector:
      optionalText(raw.url) ||
      optionalText(raw.query) ||
      (optionalNumber(raw.urlIndex) !== undefined ? `URL #${optionalNumber(raw.urlIndex)}` : "") ||
      (optionalNumber(raw.queryIndex) !== undefined
        ? `query #${optionalNumber(raw.queryIndex)}`
        : ""),
    offset: optionalNumber(raw.offset),
    limit: optionalNumber(raw.limit),
    view: decodeWebAccessRendererView("get_search_content", result ? rawResult(result) : undefined),
  }),
  header: (a) => (
    <>
      <span class="tool-name">get_search_content</span>
      <span class="line-count">
        {" "}
        · {a.responseId === null ? "[invalid arg]" : a.responseId}
        {a.selector ? ` · ${a.selector}` : ""}
        {a.offset === undefined && a.limit === undefined
          ? ""
          : ` · from ${a.offset ?? 0}${a.limit === undefined ? "" : ` for ${a.limit} chars`}`}
      </span>
    </>
  ),
  status: (a) =>
    a.view.status === "running" ? "pending" : a.view.status === "completed" ? "success" : "error",
  body: (a, result, ctx) =>
    !result ? null : (
      <StructuredBody
        view={a.view}
        result={result}
        expanded={ctx.expanded}
        dkey={ctx.dkey}
        images
      />
    ),
});

const sourceCheck = defineTool({
  names: ["source_check"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw, result) => ({
    claim: requiredText(raw.claim),
    queries: textList(raw.queries),
    numResults: optionalNumber(raw.numResults),
    provider: optionalText(raw.provider),
    recency: optionalText(raw.recencyFilter),
    domains: textList(raw.domainFilter),
    fetchContent: flag(raw.fetchContent),
    view: decodeWebAccessRendererView("source_check", result ? rawResult(result) : undefined),
  }),
  header: (a, { expanded }) => (
    <>
      <span class="tool-name">source_check</span>
      <span class="line-count">
        {" "}
        · {a.claim === null ? "[invalid arg]" : expanded ? a.claim : truncate(a.claim, 120)}
      </span>
      <span class="line-count">
        {[
          a.queries.length > 1 ? pluralize(a.queries.length, "query") : "",
          a.provider && a.provider !== "auto" ? a.provider : "",
          a.numResults === undefined ? "" : `${a.numResults} per query`,
          a.recency ? `past ${a.recency}` : "",
          a.domains.length ? a.domains.join(", ") : "",
          a.fetchContent ? "with passages" : "",
        ]
          .filter(Boolean)
          .map((p) => ` · ${p}`)
          .join("")}
      </span>
    </>
  ),
  status: (a) =>
    a.view.status === "running" ? "pending" : a.view.status === "completed" ? "success" : "error",
  body: (a, result, ctx) =>
    !result ? null : (
      <StructuredBody
        view={a.view}
        result={result}
        expanded={ctx.expanded}
        dkey={ctx.dkey}
        images
      />
    ),
});

export const WEB_ACCESS_TOOLS: readonly RegisteredTool[] = [
  webSearch,
  fetchContent,
  getSearchContent,
  sourceCheck,
];
