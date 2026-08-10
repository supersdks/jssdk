export const LIMITS = Object.freeze({
  settings: Object.freeze({
    cacheTtlMs: 30_000,
    cacheTtlMsMax: 300_000,
    maxCacheEntries: 64,
    maxCacheEntriesHard: 256,
    maxValueBytes: 256 * 1024,
    maxValueBytesHard: 1024 * 1024,
    maxParamsBytes: 16 * 1024,
    maxParamsBytesHard: 64 * 1024,
    timeoutMs: 5_000,
    timeoutMsMax: 15_000
  }),
  analytics: Object.freeze({
    queueCapacity: 500,
    queueCapacityHard: 2_000,
    maxEventBytes: 32 * 1024,
    batchSize: 50,
    batchSizeHard: 100,
    maxBatchBytes: 512 * 1024,
    maxBatchBytesHard: 1024 * 1024,
    maxAgeMs: 3 * 24 * 60 * 60 * 1000,
    maxAgeMsHard: 7 * 24 * 60 * 60 * 1000,
    maxRetries: 8,
    maxRetriesHard: 12,
    baseBackoffMs: 1_000,
    maxBackoffMs: 5 * 60 * 1000,
    flushTimeoutMs: 5_000,
    flushTimeoutMsMax: 15_000,
    flushIntervalMs: 10_000,
    flushIntervalMsMax: 60_000
  })
});
