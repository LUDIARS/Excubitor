/**
 * Genius の `genius.config.example.json` と同じ runtime config の初期値。
 *
 * HTTP port は Excubitor catalog / ProcessMap が所有し、GENIUS_PORT として
 * 別に注入されるため、この暗号化 payload には含めない。
 */
export const GENIUS_RUNTIME_CONFIG_TEMPLATE = {
  dataDir: './data',
  embedding: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    dim: 1024,
    numGpu: null,
    keepAlive: null,
  },
  distill: {
    backend: 'claude-cli',
    model: 'claude-haiku-4-5-20251001',
    sensitiveCheckModel: 'claude-haiku-4-5-20251001',
    ollamaModel: 'gemma4:12b',
  },
  notify: {
    concordiaBaseUrl: null,
  },
  questions: {
    enabled: true,
    maxPerRun: 5,
    maxOpen: 20,
    lowConfidenceBelow: 0.5,
    retrievalMissBelow: 0.5,
    discordEnabled: true,
  },
  contradiction: {
    situationSimilarityMin: 0.85,
    judgmentSimilarityMax: 0.5,
  },
  queryLog: {
    enabled: true,
    retentionDays: 30,
  },
  sources: {
    memoryDir: null,
    sessionLogsDir: null,
    channelArchivesDir: null,
    reviewDir: null,
    claudeProjectsDir: null,
    codexSessionsDir: null,
    memoriaBaseUrl: null,
  },
} as const;

/**
 * Web UI に表示する、全設定項目を含む編集用 JSON。
 * @implements SPEC-SERVICE-RUNTIME-CONFIG-GENIUS-TEMPLATE
 */
export function createGeniusRuntimeConfigTemplate(): string {
  return `${JSON.stringify(GENIUS_RUNTIME_CONFIG_TEMPLATE, null, 2)}\n`;
}
