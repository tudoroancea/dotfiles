// Host-neutral protocol limits shared by every producer and the browser client.
//
// These producer/client bounds keep operation frames, initial windows, history
// pages, commands, and renderer inputs finite across both supported hosts.

export const LIMITS = Object.freeze({
  // Legacy full-snapshot fixture bound retained for Phase 2 compatibility tests.
  maxEntries: 200_000,
  // Incremental protocol snapshots carry only the latest bounded branch window.
  maxSnapshotEntries: 200,
  // Maximum accepted characters for a single user-composed message.
  maxInputChars: 32 * 1024,
  // Maximum accepted characters for an `@` completion query.
  maxCompletionQueryChars: 4 * 1024,
  // Completion results are always truncated to this many rows.
  maxCompletionItems: 20,
  // Maximum candidates inspected while filtering a best-effort completion response.
  maxCompletionCandidates: 1000,
  maxCompletionValueChars: 1024,
  maxCompletionLabelChars: 512,
  maxCompletionDescriptionChars: 1024,
  maxMetadataStringChars: 4096,
  maxModelProviderChars: 128,
  maxModelIdChars: 256,
  maxModelNameChars: 256,
  maxModelChoices: 256,
  maxSystemPromptChars: 1024 * 1024,
  maxPendingInputs: 100,
  maxThemeProperties: 128,
  maxThemeKeyChars: 128,
  maxThemeValueChars: 64,
  maxSnapshotFrameChars: 16 * 1024 * 1024,
  maxGenerationChars: 128,
  maxIdentityChars: 256,
  maxOperations: 256,
  maxAppendEntries: 2_000,
  maxLiveEntries: 256,
  maxHistoryEntries: 2_000,
  maxHistoryPageSize: 2_000,
  maxCursorChars: 1024,
  maxErrorChars: 4096,
  maxResetReasonChars: 512,
  // Image references are independently bounded from transcript/frame limits.
  maxImageIdChars: 96,
  maxImageBytes: 5 * 1024 * 1024,
  maxImageWidth: 8192,
  maxImageHeight: 8192,
  maxImagePixels: 40_000_000,
  maxImagesPerEntry: 8,
  maxImageSourceBytesPerEntry: 5 * 1024 * 1024,
  maxRetainedImageBytes: 32 * 1024 * 1024,
  maxRetainedImageCount: 256,
  maxConcurrentImageResponses: 4,
});
