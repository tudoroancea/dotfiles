// Public testing entry: deterministic fixtures and a host-free mock transport.

export {
  BASE_METADATA,
  broadFixtureEntries,
  broadSnapshot,
  generateLargeSession,
  HOSTILE_MARKDOWN,
  imageFixtureEntries,
  FIXTURE_IMAGE_ID,
  LONG_PATH,
} from "./fixtures.ts";
export { createMockTransport } from "./mock-transport.ts";
export {
  questionnaireDecoderFixtures,
  questionnaireFixtureEntries,
  QUESTIONNAIRE_HOSTILE_TEXT,
} from "./questionnaire-fixtures.ts";
export {
  createMockIncrementalTransport,
  type MockIncrementalScript,
  type MockIncrementalTransport,
} from "./mock-incremental-transport.ts";
export {
  toolShowcaseScenario,
  TOOL_SHOWCASE_IMAGE,
  type ToolShowcaseIdentity,
  type ToolShowcaseScenario,
  type ToolShowcaseStep,
} from "./tool-showcase.ts";
export {
  appendOperationFixture,
  coreConformanceScenario,
  imageAttachmentCapabilityFixture,
  invalidCoreConformanceFixtures,
  modelControlCapabilityFixture,
  outboundImageAttachmentFixture,
  sessionSnapshotFixture,
  type CoreConformanceStep,
  type InvalidCoreConformanceFixture,
} from "./session-fixtures.ts";
