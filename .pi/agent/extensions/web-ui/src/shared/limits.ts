export const LIMITS = Object.freeze({
  httpHeaderBytes: 16 * 1024,
  incomingWebSocketBytes: 64 * 1024,
  commandIdUtf8Bytes: 128,
  promptUtf8Bytes: 8 * 1024,
  projectedImageSourceBytes: 1024 * 1024,
  projectedImagesPerMessage: 4,
  outboundMessageBytes: 8 * 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  toolTextUtf8Bytes: 1024 * 1024,
  connectedClients: 4,
  outboundMessagesPerClient: 256,
  outboundBytesPerClient: 16 * 1024 * 1024,
  bootstrapCredentialTtlMs: 60_000,
});

export type WebUiLimits = typeof LIMITS;
