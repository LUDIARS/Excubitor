/** @implements SPEC-EX-DNS-FILTER */
/**
 * DNS フィルタの組み立て。 設定を周期で確かめ、 規則ファイルの読み込み・期限切れの除去・
 * 待ち受けの開け閉めを行う。 API には状態・履歴・規則の操作を渡す。
 *
 * 待ち受け中に設定が不正になったら、 直前の設定のまま待ち受けを続けて理由を出す
 * (この PC の DNS がここを向いているので、 止めると名前解決が全部止まるため)。
 */

import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { AtomicTextFile } from '../netwatch/atomic-text-file.js';
import { readTextIfPresent } from '../netwatch/block-runtime.js';
import { DomainSet, type RuleBook } from './domain-rules.js';
import { formatEndpoint } from './endpoint.js';
import { DnsListener } from './listener.js';
import { QueryLog, type QueryCounters, type QueryRecord } from './query-log.js';
import { DnsFilterResolver, type ResolvedAnswer } from './resolver.js';
import { RuleRegistry } from './rule-registry.js';
import { RuleService } from './rule-service.js';
import { resolveDnsFilterSettings, serverKey, type RuleSettings, type ServerSettings } from './settings.js';
import { createForwarder, type Forwarder } from './upstream.js';
import type { Endpoint } from './endpoint.js';

const logger = createNamedLogger('excubitor.dns-filter');
const RECONCILE_INTERVAL_MS = 5_000;
/** 待ち受けていないときの履歴の大きさ (設定が読めたら合わせる)。 */
const INITIAL_LOG_SIZE = 500;

export type DnsFilterState = 'off' | 'starting' | 'running' | 'failed';

export interface DnsFilterStatus {
  state: DnsFilterState;
  reason: string | null;
  /** 待ち受け中に設定が不正になったときの理由 (待ち受けは直前の設定で続ける)。 */
  configError: string | null;
  listen: string[];
  upstream: string | null;
  counters: QueryCounters;
  inFlight: number;
  rules: { api: number; config: number; doh: number; allowed: number };
}

export interface DnsFilterHandle {
  status: () => DnsFilterStatus;
  queries: (limit: number, filter?: (record: QueryRecord) => boolean) => QueryRecord[];
  rules: RuleService;
  stop: () => Promise<void>;
}

export interface DnsFilterDeps {
  getCatalog: () => Catalog;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  onAnswer?: (answer: ResolvedAnswer) => void;
  /** テスト用: 上流への中継。 */
  createForwarder?: (upstream: Endpoint, timeoutMs: number) => Forwarder;
  readText?: (path: string) => Promise<string | null>;
  writeText?: (path: string, content: string) => Promise<void>;
}

const EMPTY_SET = new DomainSet();

export function startDnsFilter(deps: DnsFilterDeps): DnsFilterHandle {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const readText = deps.readText ?? readTextIfPresent;
  const files = new Map<string, AtomicTextFile>();
  const writeText = deps.writeText ?? (async (path: string, content: string) => {
    const file = files.get(path) ?? new AtomicTextFile(path);
    files.set(path, file);
    await file.write(content);
  });
  const makeForwarder = deps.createForwarder ?? createForwarder;

  let ruleSettings: RuleSettings | null = null;
  let disabledReason: string | null = '読み込み中';
  let loadedFile: string | null = null;
  const registry = new RuleRegistry();
  const log = new QueryLog(INITIAL_LOG_SIZE);

  // 判定に使う規則の集合。 規則か設定が変わったときだけ作り直す。
  let book: RuleBook = { allowed: EMPTY_SET, blocked: [] };
  let bookKey: { revision: number; settings: RuleSettings | null } = { revision: -1, settings: null };
  const currentBook = (): RuleBook => {
    if (bookKey.revision !== registry.revision || bookKey.settings !== ruleSettings) {
      const settings = ruleSettings;
      book = settings
        ? {
          allowed: settings.allowed,
          blocked: [
            { source: 'api', set: new DomainSet(registry.list(now()).map((entry) => entry.domain)) },
            { source: 'config', set: settings.blocked },
            { source: 'doh', set: settings.doh },
          ],
        }
        : { allowed: EMPTY_SET, blocked: [] };
      bookKey = { revision: registry.revision, settings };
    }
    return book;
  };

  const rules = new RuleService({
    registry,
    limits: () => ruleSettings && loadedFile === ruleSettings.file
      ? { limits: { maxRules: ruleSettings.maxRules, maxTtlMs: ruleSettings.maxTtlMs, allowed: ruleSettings.allowed }, reason: null }
      : { limits: null, reason: disabledReason ?? '規則ファイルの読み込み中' },
    persist: (content) => {
      if (!ruleSettings) return Promise.reject(new Error('DNS フィルタは無効'));
      return writeText(ruleSettings.file, content);
    },
    now,
  });

  let state: DnsFilterState = 'off';
  let serverReason: string | null = null;
  let configError: string | null = null;
  let activeKey: string | null = null;
  let activeServer: ServerSettings | null = null;
  let listeners: DnsListener[] = [];
  let resolver: DnsFilterResolver | null = null;
  let switching: Promise<void> = Promise.resolve();

  const closeListeners = async (): Promise<void> => {
    const closing = listeners;
    listeners = [];
    resolver = null;
    await Promise.all(closing.map((listener) => listener.stop()));
  };

  const openServer = async (server: ServerSettings): Promise<void> => {
    await closeListeners();
    log.resize(server.queryLogSize);
    resolver = new DnsFilterResolver({
      rules: currentBook,
      clients: server.clients,
      forward: makeForwarder(server.upstream, server.upstreamTimeoutMs),
      log,
      maxInFlight: server.maxInFlight,
      now,
      onAnswer: deps.onAnswer,
    });
    const handler = resolver;
    const opened = server.listen.map((endpoint) => new DnsListener(
      endpoint,
      (packet, client) => handler.handle(packet, client),
      (level, message, detail) => logger[level](detail, message),
    ));
    state = 'starting';
    activeServer = server;
    try {
      for (const listener of opened) {
        await listener.start();
        listeners.push(listener);
      }
      state = 'running';
      serverReason = null;
      logger.info({ listen: server.listen.map(formatEndpoint), upstream: formatEndpoint(server.upstream) }, 'dns-filter: listening');
    } catch (error) {
      await closeListeners();
      state = 'failed';
      serverReason = (error as Error).message;
      // 次の確認で開き直す (ポートが空くのを待つ)。
      activeKey = null;
      logger.warn({ err: serverReason }, 'dns-filter: listen failed');
    }
  };

  const loadRules = async (file: string): Promise<void> => {
    try {
      registry.load(await readText(file));
    } catch (error) {
      registry.fail(`規則ファイルを読めない: ${(error as Error).message}`);
      logger.warn({ err: (error as Error).message, file }, 'dns-filter: rules file unreadable');
    }
    loadedFile = file;
  };

  const reconcile = async (): Promise<void> => {
    let resolved;
    try {
      resolved = resolveDnsFilterSettings(deps.getCatalog(), env, cwd);
    } catch (error) {
      const message = `設定が不正: ${(error as Error).message}`;
      if (state === 'running') {
        configError = message;
        return;
      }
      ruleSettings = null;
      disabledReason = message;
      state = 'failed';
      serverReason = message;
      return;
    }
    configError = null;
    ruleSettings = resolved.rules;
    disabledReason = resolved.disabledReason;
    if (ruleSettings && loadedFile !== ruleSettings.file) await loadRules(ruleSettings.file);
    if (ruleSettings) await rules.expire().catch((error: unknown) => {
      logger.warn({ err: (error as Error).message }, 'dns-filter: expiry write failed');
    });
    const server = resolved.server;
    if (!server) {
      if (listeners.length > 0) await closeListeners();
      activeKey = null;
      activeServer = null;
      state = 'off';
      serverReason = resolved.disabledReason;
      return;
    }
    const key = serverKey(server);
    if (key !== activeKey) {
      activeKey = key;
      await openServer(server);
    } else if (activeServer) {
      log.resize(server.queryLogSize);
    }
  };

  const schedule = (): void => {
    switching = switching.then(reconcile).catch((error: unknown) => {
      logger.warn({ err: (error as Error).message }, 'dns-filter: reconcile failed');
    });
  };

  schedule();
  const timer = setInterval(schedule, RECONCILE_INTERVAL_MS);
  timer.unref();

  const status = (): DnsFilterStatus => {
    const settings = ruleSettings;
    return {
      state,
      reason: serverReason,
      configError,
      listen: activeServer?.listen.map(formatEndpoint) ?? [],
      upstream: activeServer ? formatEndpoint(activeServer.upstream) : null,
      counters: { ...log.counters },
      inFlight: resolver?.pending ?? 0,
      rules: {
        api: registry.list(now()).length,
        config: settings?.blocked.size ?? 0,
        doh: settings?.doh.size ?? 0,
        allowed: settings?.allowed.size ?? 0,
      },
    };
  };

  return {
    status,
    queries: (limit, filter) => log.recent(limit, filter),
    rules,
    stop: async () => {
      clearInterval(timer);
      await switching;
      await closeListeners();
      state = 'off';
    },
  };
}
