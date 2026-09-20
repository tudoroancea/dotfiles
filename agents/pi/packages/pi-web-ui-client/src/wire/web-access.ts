import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Number as TypeNumber,
  Null as TypeNull,
  Object as TypeObject,
  Optional as TypeOptional,
  String as TypeString,
  Union as TypeUnion,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";

/** Browser renderer limits for opaque pi-web-access details. */
export const WEB_ACCESS_LIMITS = {
  maxQueries: 32,
  maxSourcesPerQuery: 20,
  maxErrors: 32,
  maxUrls: 32,
  maxTextChars: 8_192,
  maxShortChars: 1_024,
  maxUrlChars: 2_048,
  maxCount: 1_000_000_000,
} as const;

const Strict = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const Short = TypeString({ maxLength: WEB_ACCESS_LIMITS.maxShortChars });
const Long = TypeString({ maxLength: WEB_ACCESS_LIMITS.maxTextChars });
const Url = TypeString({ maxLength: WEB_ACCESS_LIMITS.maxUrlChars });
const Count = TypeNumber({ minimum: 0, maximum: WEB_ACCESS_LIMITS.maxCount, multipleOf: 1 });
const NullableShort = TypeUnion([Short, TypeNull()]);

export const WebAccessSourceViewSchema = Strict({ title: Short, url: Url, host: Short });
export const WebAccessQueryViewSchema = Strict({
  query: Short,
  provider: NullableShort,
  answer: TypeOptional(Long),
  sources: TypeArray(WebAccessSourceViewSchema, { maxItems: WEB_ACCESS_LIMITS.maxSourcesPerQuery }),
  error: TypeOptional(Short),
});
export const WebAccessDiagnosticSchema = Strict({
  cancelReason: TypeOptional(Short),
  browserConnected: TypeOptional(TypeBoolean()),
  lastHeartbeatAgeMs: TypeOptional(Count),
  queryCount: TypeOptional(Count),
  queries: TypeArray(
    Strict({
      query: Short,
      provider: NullableShort,
      error: TypeOptional(Short),
      resultCount: Count,
    }),
    { maxItems: WEB_ACCESS_LIMITS.maxQueries },
  ),
  extraLines: TypeArray(Short, { maxItems: WEB_ACCESS_LIMITS.maxErrors }),
});
export const WebAccessSummaryViewSchema = Strict({
  text: Long,
  workflow: Short,
  model: NullableShort,
  durationMs: Count,
  tokenEstimate: Count,
  fallbackUsed: TypeBoolean(),
  fallbackReason: TypeOptional(Short),
  phase: TypeOptional(Short),
  edited: TypeBoolean(),
});
export const WebAccessArtifactViewSchema = Strict({
  claim: Short,
  status: TypeOptional(Short),
  confidence: TypeOptional(TypeNumber({ minimum: 0, maximum: 1 })),
  rationale: TypeOptional(Long),
  supportingPassages: TypeArray(Short, { maxItems: WEB_ACCESS_LIMITS.maxSourcesPerQuery }),
  contradictingPassages: TypeArray(Short, { maxItems: WEB_ACCESS_LIMITS.maxSourcesPerQuery }),
  sources: TypeArray(Strict({ title: Short, url: Url, host: Short, quality: Short, rank: Count }), {
    maxItems: WEB_ACCESS_LIMITS.maxSourcesPerQuery,
  }),
  errors: TypeArray(Strict({ query: Short, error: Short }), {
    maxItems: WEB_ACCESS_LIMITS.maxErrors,
  }),
});
const Status = TypeUnion([
  TypeLiteral("running"),
  TypeLiteral("completed"),
  TypeLiteral("failed"),
  TypeLiteral("cancelled"),
]);
export const WebAccessRendererViewSchema = Strict({
  tool: TypeUnion([
    TypeLiteral("web_search"),
    TypeLiteral("fetch_content"),
    TypeLiteral("get_search_content"),
    TypeLiteral("source_check"),
  ]),
  status: Status,
  phase: TypeOptional(Short),
  progress: TypeOptional(TypeNumber({ minimum: 0, maximum: 1 })),
  currentQuery: TypeOptional(Short),
  error: TypeOptional(Short),
  curatorGuidance: TypeOptional(Short),
  curatorUrl: TypeOptional(Url),
  timeoutSeconds: TypeOptional(Count),
  shortcut: TypeOptional(Short),
  queryCount: TypeOptional(Count),
  successfulQueries: TypeOptional(Count),
  totalResults: TypeOptional(Count),
  curated: TypeBoolean(),
  curatedFrom: TypeOptional(Count),
  queries: TypeArray(WebAccessQueryViewSchema, { maxItems: WEB_ACCESS_LIMITS.maxQueries }),
  summary: TypeOptional(WebAccessSummaryViewSchema),
  diagnostics: TypeOptional(WebAccessDiagnosticSchema),
  fetchUrls: TypeArray(Url, { maxItems: WEB_ACCESS_LIMITS.maxUrls }),
  fetchId: TypeOptional(Short),
  urlCount: TypeOptional(Count),
  successful: TypeOptional(Count),
  totalChars: TypeOptional(Count),
  title: TypeOptional(Short),
  responseId: TypeOptional(Short),
  truncated: TypeBoolean(),
  imageCount: TypeOptional(Count),
  duration: TypeOptional(TypeNumber({ minimum: 0, maximum: WEB_ACCESS_LIMITS.maxCount })),
  contentLength: TypeOptional(Count),
  offset: TypeOptional(Count),
  returnedChars: TypeOptional(Count),
  nextOffset: TypeOptional(TypeUnion([Count, TypeNull()])),
  resultCount: TypeOptional(Count),
  artifact: TypeOptional(WebAccessArtifactViewSchema),
  malformed: TypeBoolean(),
  omitted: Count,
  notices: TypeArray(Short, { maxItems: 16 }),
});
export type WebAccessRendererView = Static<typeof WebAccessRendererViewSchema>;
export type WebAccessQueryView = Static<typeof WebAccessQueryViewSchema>;

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : null;
const txt = (v: unknown, max: number = WEB_ACCESS_LIMITS.maxShortChars) =>
  typeof v === "string" ? v.replaceAll("\0", "").slice(0, max) : undefined;
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(Math.floor(v), WEB_ACCESS_LIMITS.maxCount)
    : undefined;

function isLoopbackHost(value: string): boolean {
  const host = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)) return Number(ipv4[1]) === 127;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return (
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(host) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(host)
  );
}

/** Only externally useful HTTP(S) URLs survive. Curator loopback URLs are never actionable. */
export function safeWebAccessUrl(value: unknown, curator = false): string | undefined {
  if (typeof value !== "string" || value.length > WEB_ACCESS_LIMITS.maxUrlChars) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (curator && isLoopbackHost(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function source(v: unknown): Static<typeof WebAccessSourceViewSchema> | undefined {
  const r = rec(v);
  const url = safeWebAccessUrl(r?.url);
  if (!r || !url) return undefined;
  const title = txt(r.title)?.trim();
  return { title: title || url, url, host: new URL(url).hostname.slice(0, 1_024) };
}

function queries(v: unknown): {
  values: WebAccessQueryView[];
  omitted: number;
  omittedSources: number;
  truncatedAnswers: number;
} {
  if (!Array.isArray(v)) return { values: [], omitted: 0, omittedSources: 0, truncatedAnswers: 0 };
  const values: WebAccessQueryView[] = [];
  let omittedSources = 0;
  let truncatedAnswers = 0;
  const scan = Math.min(v.length, WEB_ACCESS_LIMITS.maxQueries * 4);
  for (let i = 0; i < scan && values.length < WEB_ACCESS_LIMITS.maxQueries; i++) {
    const r = rec(v[i]);
    const query = txt(r?.query);
    if (!r || query === undefined) continue;
    const rawSources = Array.isArray(r.sources) ? r.sources : [];
    const sources = rawSources
      .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery * 4)
      .map(source)
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery);
    omittedSources += Math.max(0, rawSources.length - sources.length);
    if (typeof r.answer === "string" && r.answer.length > WEB_ACCESS_LIMITS.maxTextChars)
      truncatedAnswers += 1;
    values.push({
      query,
      provider: txt(r.provider) ?? null,
      ...(txt(r.answer, WEB_ACCESS_LIMITS.maxTextChars)
        ? { answer: txt(r.answer, WEB_ACCESS_LIMITS.maxTextChars) }
        : {}),
      sources,
      ...(txt(r.error) ? { error: txt(r.error) } : {}),
    });
  }
  return {
    values,
    omitted: Math.max(0, v.length - values.length),
    omittedSources,
    truncatedAnswers,
  };
}

export function decodeWebAccessRendererView(
  tool: WebAccessRendererView["tool"],
  rawResult?: unknown,
): WebAccessRendererView {
  const empty: WebAccessRendererView = {
    tool,
    status: rawResult === undefined ? "running" : "completed",
    curated: false,
    queries: [],
    fetchUrls: [],
    truncated: false,
    malformed: false,
    omitted: 0,
    notices: [],
  };
  try {
    const result = rec(rawResult);
    const details = rec(result?.details);
    if (!result) return { ...empty, malformed: rawResult !== undefined };
    if (!details)
      return {
        ...empty,
        status:
          result.isError === true ? "failed" : result.isPartial === true ? "running" : "completed",
      };
    const error = txt(details.error);
    const cancelled = details.cancelled === true;
    const phase = txt(details.phase);
    const progressRaw =
      typeof details.progress === "number" && Number.isFinite(details.progress)
        ? details.progress
        : undefined;
    const decodedQueries = queries(details.curatedQueries);
    const rawCancelled = Array.isArray(details.cancelledQueries) ? details.cancelledQueries : [];
    const diagnosticQueries = rawCancelled
      .slice(0, WEB_ACCESS_LIMITS.maxQueries)
      .flatMap((value) => {
        const q = rec(value);
        const query = txt(q?.query);
        if (!q || query === undefined) return [];
        return [
          {
            query,
            provider: txt(q.provider) ?? null,
            ...(txt(q.error) ? { error: txt(q.error) } : {}),
            resultCount: count(q.resultCount) ?? 0,
          },
        ];
      });
    const extras = Array.isArray(details.extraLines)
      ? details.extraLines
          .slice(0, WEB_ACCESS_LIMITS.maxErrors)
          .flatMap((v) => (txt(v) === undefined ? [] : [txt(v)!]))
      : [];
    const summaryRaw = rec(details.summary);
    const summaryText = txt(summaryRaw?.text, WEB_ACCESS_LIMITS.maxTextChars);
    const artifactRaw = rec(details.artifact);
    const claims = Array.isArray(artifactRaw?.claims) ? artifactRaw.claims : [];
    const claim = rec(claims[0]);
    const artifactSources = Array.isArray(artifactRaw?.sources)
      ? artifactRaw.sources
          .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery * 4)
          .flatMap((value) => {
            const r = rec(value);
            const item = source(value);
            if (!r || !item) return [];
            return [{ ...item, quality: txt(r.quality) ?? "unknown", rank: count(r.rank) ?? 0 }];
          })
          .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery)
      : [];
    const artifactErrors = Array.isArray(artifactRaw?.errors)
      ? artifactRaw.errors.slice(0, WEB_ACCESS_LIMITS.maxErrors).flatMap((value) => {
          const r = rec(value);
          const query = txt(r?.query);
          const e = txt(r?.error);
          return query !== undefined && e !== undefined ? [{ query, error: e }] : [];
        })
      : [];
    const supportingPassages = Array.isArray(claim?.supporting_passages)
      ? claim.supporting_passages
          .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery)
          .flatMap((value) => (txt(value) === undefined ? [] : [txt(value)!]))
      : [];
    const contradictingPassages = Array.isArray(claim?.contradicting_passages)
      ? claim.contradicting_passages
          .slice(0, WEB_ACCESS_LIMITS.maxSourcesPerQuery)
          .flatMap((value) => (txt(value) === undefined ? [] : [txt(value)!]))
      : [];
    const curatorUrl = safeWebAccessUrl(details.curatorUrl, true);
    const browserOpenError = txt(details.browserOpenError);
    const diagnostic = cancelled || diagnosticQueries.length || extras.length || browserOpenError;
    const rawFetchUrls = Array.isArray(details.fetchUrls)
      ? details.fetchUrls
      : Array.isArray(details.urls)
        ? details.urls
        : [];
    const notices = [
      decodedQueries.omitted ? `${decodedQueries.omitted} query records omitted` : "",
      decodedQueries.omittedSources
        ? `${decodedQueries.omittedSources} source records omitted`
        : "",
      decodedQueries.truncatedAnswers
        ? `${decodedQueries.truncatedAnswers} query answers truncated for display`
        : "",
      rawCancelled.length > diagnosticQueries.length
        ? `${rawCancelled.length - diagnosticQueries.length} diagnostic query records omitted`
        : "",
      Array.isArray(details.extraLines) && details.extraLines.length > extras.length
        ? `${details.extraLines.length - extras.length} diagnostic lines omitted`
        : "",
      rawFetchUrls.length > WEB_ACCESS_LIMITS.maxUrls
        ? `${rawFetchUrls.length - WEB_ACCESS_LIMITS.maxUrls} URLs omitted`
        : "",
      Array.isArray(artifactRaw?.sources) && artifactRaw.sources.length > artifactSources.length
        ? `${artifactRaw.sources.length - artifactSources.length} artifact sources omitted`
        : "",
      Array.isArray(artifactRaw?.errors) && artifactRaw.errors.length > artifactErrors.length
        ? `${artifactRaw.errors.length - artifactErrors.length} artifact errors omitted`
        : "",
      typeof summaryRaw?.text === "string" &&
      summaryRaw.text.length > WEB_ACCESS_LIMITS.maxTextChars
        ? "Summary text truncated for display"
        : "",
      Array.isArray(claim?.supporting_passages) &&
      claim.supporting_passages.length > supportingPassages.length
        ? `${claim.supporting_passages.length - supportingPassages.length} supporting passage ids omitted`
        : "",
      Array.isArray(claim?.contradicting_passages) &&
      claim.contradicting_passages.length > contradictingPassages.length
        ? `${claim.contradicting_passages.length - contradictingPassages.length} contradicting passage ids omitted`
        : "",
    ]
      .filter(Boolean)
      .slice(0, 16);
    const view: WebAccessRendererView = {
      tool,
      status:
        error || result.isError === true
          ? cancelled
            ? "cancelled"
            : "failed"
          : result.isPartial === true
            ? "running"
            : "completed",
      ...(phase ? { phase } : {}),
      ...(progressRaw === undefined ? {} : { progress: Math.max(0, Math.min(1, progressRaw)) }),
      ...(txt(details.currentQuery) ? { currentQuery: txt(details.currentQuery) } : {}),
      ...(error ? { error } : {}),
      ...(phase === "curator-fallback"
        ? {
            curatorGuidance:
              "Open the search curator in the session browser, or use the shortcut to reopen it.",
          }
        : {}),
      ...(curatorUrl ? { curatorUrl } : {}),
      ...(count(details.timeoutSeconds) === undefined
        ? {}
        : { timeoutSeconds: count(details.timeoutSeconds) }),
      ...(txt(details.shortcut) ? { shortcut: txt(details.shortcut) } : {}),
      ...(count(details.queryCount) === undefined ? {} : { queryCount: count(details.queryCount) }),
      ...(count(details.successfulQueries) === undefined
        ? {}
        : { successfulQueries: count(details.successfulQueries) }),
      ...(count(details.totalResults) === undefined
        ? {}
        : { totalResults: count(details.totalResults) }),
      curated: details.curated === true,
      ...(count(details.curatedFrom) === undefined
        ? {}
        : { curatedFrom: count(details.curatedFrom) }),
      queries: decodedQueries.values,
      ...(summaryText === undefined
        ? {}
        : {
            summary: {
              text: summaryText,
              workflow: txt(summaryRaw?.workflow) ?? "summary-review",
              model: txt(summaryRaw?.model) ?? null,
              durationMs: count(summaryRaw?.durationMs) ?? 0,
              tokenEstimate: count(summaryRaw?.tokenEstimate) ?? 0,
              fallbackUsed: summaryRaw?.fallbackUsed === true,
              ...(txt(summaryRaw?.fallbackReason)
                ? { fallbackReason: txt(summaryRaw?.fallbackReason) }
                : {}),
              ...(txt(summaryRaw?.phase) ? { phase: txt(summaryRaw?.phase) } : {}),
              edited: summaryRaw?.edited === true,
            },
          }),
      ...(diagnostic
        ? {
            diagnostics: {
              ...(txt(details.cancelReason) ? { cancelReason: txt(details.cancelReason) } : {}),
              ...(typeof details.browserConnected === "boolean"
                ? { browserConnected: details.browserConnected }
                : {}),
              ...(count(details.lastHeartbeatAgeMs) === undefined
                ? {}
                : { lastHeartbeatAgeMs: count(details.lastHeartbeatAgeMs) }),
              ...(count(details.queryCount) === undefined
                ? {}
                : { queryCount: count(details.queryCount) }),
              queries: diagnosticQueries,
              extraLines: browserOpenError
                ? [...extras, `browser open error: ${browserOpenError}`].slice(
                    0,
                    WEB_ACCESS_LIMITS.maxErrors,
                  )
                : extras,
            },
          }
        : {}),
      fetchUrls: rawFetchUrls
        .slice(0, WEB_ACCESS_LIMITS.maxUrls)
        .flatMap((v) => safeWebAccessUrl(v) ?? [])
        .slice(0, WEB_ACCESS_LIMITS.maxUrls),
      ...(txt(details.fetchId) ? { fetchId: txt(details.fetchId) } : {}),
      ...(count(details.urlCount) === undefined ? {} : { urlCount: count(details.urlCount) }),
      ...(count(details.successful) === undefined ? {} : { successful: count(details.successful) }),
      ...(count(details.totalChars) === undefined ? {} : { totalChars: count(details.totalChars) }),
      ...(txt(details.title) ? { title: txt(details.title) } : {}),
      ...(txt(details.responseId) ? { responseId: txt(details.responseId) } : {}),
      truncated: details.truncated === true,
      ...(count(details.imageCount ?? (details.hasImage === true ? 1 : undefined)) === undefined
        ? {}
        : { imageCount: count(details.imageCount ?? 1) }),
      ...(typeof details.duration === "number" &&
      Number.isFinite(details.duration) &&
      details.duration >= 0
        ? { duration: Math.min(details.duration, WEB_ACCESS_LIMITS.maxCount) }
        : {}),
      ...(count(details.contentLength) === undefined
        ? {}
        : { contentLength: count(details.contentLength) }),
      ...(count(details.offset) === undefined ? {} : { offset: count(details.offset) }),
      ...(count(details.returnedChars) === undefined
        ? {}
        : { returnedChars: count(details.returnedChars) }),
      ...(details.nextOffset === null
        ? { nextOffset: null }
        : count(details.nextOffset) === undefined
          ? {}
          : { nextOffset: count(details.nextOffset) }),
      ...(count(details.resultCount) === undefined
        ? {}
        : { resultCount: count(details.resultCount) }),
      ...(artifactRaw
        ? {
            artifact: {
              claim: txt(claim?.claim ?? artifactRaw.query) ?? "",
              ...(txt(claim?.status) ? { status: txt(claim?.status) } : {}),
              ...(typeof claim?.confidence === "number" && Number.isFinite(claim.confidence)
                ? { confidence: Math.max(0, Math.min(1, claim.confidence)) }
                : {}),
              ...(txt(claim?.rationale, WEB_ACCESS_LIMITS.maxTextChars)
                ? { rationale: txt(claim?.rationale, WEB_ACCESS_LIMITS.maxTextChars) }
                : {}),
              supportingPassages,
              contradictingPassages,
              sources: artifactSources,
              errors: artifactErrors,
            },
          }
        : {}),
      malformed: false,
      omitted: decodedQueries.omitted + Math.max(0, rawCancelled.length - diagnosticQueries.length),
      notices,
    };
    return Check(WebAccessRendererViewSchema, view) ? view : { ...empty, malformed: true };
  } catch {
    return { ...empty, malformed: true };
  }
}

export function isWebAccessRendererView(value: unknown): value is WebAccessRendererView {
  return Check(WebAccessRendererViewSchema, value);
}
