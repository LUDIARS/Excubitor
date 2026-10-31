/** @implements SPEC-EX-NETWATCH */
/**
 * 通信監視の組み立て。 設定の周期確認 (tshark の起動・停止)、 接続表の周期読み取り (送信元プロセス)、
 * Tela 用一覧ファイルの周期書き出しのタイマーを持ち、 API には集計と判定を読み出し専用で渡す。
 */

import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { AtomicTextFile } from './atomic-text-file.js';
import { CaptureSupervisor, type TsharkFactory } from './capture-supervisor.js';
import { ConnectionPoller, readNetstat, type AttributionStatus } from './connection-poller.js';
import { DestinationStore } from './destination-store.js';
import { DnsAnswerCache } from './dns-answer-cache.js';
import { netwatchListView } from './netwatch-list-view.js';
import { ObservationIngest } from './observation-ingest.js';
import { OwnerAttribution } from './owner-attribution.js';
import type { ProcessRow, ServiceRoot } from './owner-resolver.js';
import { resolveNetwatchSettings, type DetectSettings, type OverlaySettings } from './settings.js';
import { assessDestinations } from './suspicion.js';
import { renderListView } from './tela-list-format.js';
import { parseTsharkLine } from './tshark-line.js';
import { TsharkProcess } from './tshark-process.js';
import { getFreshProcessSnapshot } from '../process-snapshot/store.js';
import type { AssessedDestination, CaptureStatus, DnsAnswer } from './types.js';

const logger = createNamedLogger('excubitor.netwatch');
const RECONCILE_INTERVAL_MS = 5_000;
/** DNS 対応表の上限は通信先の上限の数倍 (使われない応答も多い)。 */
const DNS_ADDRESSES_PER_DESTINATION = 4;
/** 接続表に現れるのを待つ回数 (周期の何回分か)。 */
const PENDING_POLLS = 3;
const MAX_PENDING_LOOKUPS = 2_000;
/** 設定が読めるまでの判定 (国外以外の理由を付けない)。 */
const NO_DETECT: DetectSettings = { ownerPollMs: 0, allowedPorts: new Set(), trustedDomains: [] };

export interface NetwatchSnapshot {
  status: CaptureStatus;
  /** キャプチャの設定が一度も読めていなければ null。 */
  homeCountry: string | null;
  destinations: AssessedDestination[];
  unparsedLines: number;
  /** 送信元プロセスの特定の状態。 */
  attribution: AttributionStatus & { attributed: number; expired: number; pending: number };
}

export interface NetwatchHandle {
  snapshot: () => NetwatchSnapshot;
  /** DNS フィルタが中継して分かった「名前 → アドレス」。 キャプチャしていない拠点では捨てる。 */
  recordDnsAnswer: (answer: DnsAnswer) => void;
  stop: () => void;
}

export interface NetwatchDeps {
  getCatalog: () => Catalog;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  createProcess?: TsharkFactory;
  /** Excubitor が起動したサービスの根 pid (Excubitor 自身は常に足す)。 */
  listServiceRoots?: () => readonly ServiceRoot[];
  /** プロセス一覧 (既定は process-snapshot)。 */
  listProcesses?: () => readonly ProcessRow[] | null;
  /** 接続表 (既定は netstat -ano)。 */
  readConnections?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false });
}

function createAggregation(
  maxDestinations: number,
  homeCountry: string,
  dnsTtlMs: number,
): Aggregation {
  const store = new DestinationStore(maxDestinations, homeCountry);
  const dns = new DnsAnswerCache(maxDestinations * DNS_ADDRESSES_PER_DESTINATION, dnsTtlMs);
  return { store, ingest: new ObservationIngest(dns, store) };
}

interface Aggregation {
  store: DestinationStore;
  ingest: ObservationIngest;
}

export function startNetwatch(deps: NetwatchDeps): NetwatchHandle {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  // 集計の器は最初に設定が読めたときに作る。 起動時に設定を読むと、 読めない設定で
  // Excubitor 全体の起動を落とすため (通信監視だけを failed にする)。 大きさはそのときの値で固定。
  let aggregation: Aggregation | null = null;
  let attribution: OwnerAttribution | null = null;
  let poller: ConnectionPoller | null = null;
  let detect: DetectSettings = NO_DETECT;
  // poller を作らない (作る前に止める) ときの状態。 Windows 以外なら unsupported を出す。
  let idleAttribution: AttributionStatus = { state: 'off', reason: null, lastRefreshMs: null };
  const platform = deps.platform ?? process.platform;
  const serviceRoots = (): ServiceRoot[] => [
    { code: 'excubitor', pid: process.pid },
    ...(deps.listServiceRoots?.() ?? []),
  ];
  const noCounters = { publicObserved: 0, publicWithoutCountry: 0 };
  let unparsedLines = 0;
  let homeCountry: string | null = null;

  const supervisor = new CaptureSupervisor({
    createProcess: deps.createProcess ?? ((options) => new TsharkProcess(options)),
    onLine: (line) => {
      const observation = parseTsharkLine(line);
      if (!observation) {
        unparsedLines += 1;
        return;
      }
      const destination = aggregation?.ingest.apply(observation);
      if (destination && observation.local && poller?.status().state === 'running') {
        attribution?.observe(observation.remote, observation.local, now());
      }
    },
    onStart: () => aggregation?.ingest.resetCounters(),
    now,
    log: (level, message, detail) => logger[level](detail, message),
  });

  let overlay: OverlaySettings | null = null;
  let overlayFile: AtomicTextFile | null = null;
  let overlayTimer: NodeJS.Timeout | null = null;
  let overlayWriting = false;

  const attributionSnapshot = (): NetwatchSnapshot['attribution'] => ({
    ...(poller?.status() ?? idleAttribution),
    attributed: attribution?.counters.attributed ?? 0,
    expired: attribution?.counters.expired ?? 0,
    pending: attribution?.pendingCount ?? 0,
  });

  const snapshot = (): NetwatchSnapshot => ({
    status: supervisor.status(aggregation?.ingest.counters ?? noCounters),
    homeCountry,
    destinations: assessDestinations(aggregation?.store.list() ?? [], detect),
    unparsedLines,
    attribution: attributionSnapshot(),
  });

  /** 送信元プロセスの特定を設定に合わせる。 キャプチャしている間だけ動かす。 */
  const applyAttribution = (store: DestinationStore | null, pollMs: number): void => {
    const idle = (state: 'off' | 'unsupported', reason: string | null): void => {
      idleAttribution = { state, reason, lastRefreshMs: null };
      poller?.stop(state, reason);
    };
    if (!store) return idle('off', null);
    if (pollMs === 0) return idle('off', 'netwatch.detect.owner_poll_sec=0');
    if (platform !== 'win32') return idle('unsupported', 'Windows 以外は送信元プロセスを特定しない');
    attribution ??= new OwnerAttribution(store, {
      pendingTtlMs: pollMs * PENDING_POLLS,
      maxPending: MAX_PENDING_LOOKUPS,
    });
    const owners = attribution;
    poller ??= new ConnectionPoller({
      attribution: owners,
      readConnections: deps.readConnections ?? readNetstat,
      listProcesses: deps.listProcesses ?? (() => getFreshProcessSnapshot()?.processes ?? null),
      listServiceRoots: serviceRoots,
      now,
    });
    poller.start(pollMs);
  };

  const writeOverlay = async (): Promise<void> => {
    if (!overlay?.file || !overlayFile || overlayWriting) return;
    overlayWriting = true;
    try {
      const current = snapshot();
      const view = netwatchListView(current.destinations, current.status, current.attribution, {
        maxRows: overlay.maxRows,
        include: overlay.include,
        formatTime: formatClock,
      });
      await overlayFile.write(renderListView(view));
    } catch (error) {
      logger.warn({ err: (error as Error).message, file: overlay.file }, 'netwatch: overlay write failed');
    } finally {
      overlayWriting = false;
    }
  };

  const stopOverlay = (): void => {
    if (overlayTimer) clearInterval(overlayTimer);
    overlayTimer = null;
    overlay = null;
    overlayFile = null;
  };

  // 止めるときは止まった理由を一度書いてから書き出しをやめる。 最後の「動作中」の一覧を
  // 残すと、 Tela が古い通信先を今のものとして出し続けるため。
  let retiring = false;
  const retireOverlay = (): void => {
    if (!overlay || retiring) return;
    retiring = true;
    void writeOverlay().finally(() => {
      stopOverlay();
      retiring = false;
    });
  };

  const applyOverlay = (next: OverlaySettings): void => {
    const unchanged = overlay && overlay.file === next.file && overlay.intervalMs === next.intervalMs;
    overlay = next;
    if (unchanged) return;
    if (overlayTimer) clearInterval(overlayTimer);
    overlayTimer = null;
    overlayFile = next.file ? new AtomicTextFile(next.file) : null;
    if (next.file) {
      overlayTimer = setInterval(() => { void writeOverlay(); }, next.intervalMs);
      overlayTimer.unref();
    }
  };

  const reconcile = (): void => {
    let resolved;
    try {
      resolved = resolveNetwatchSettings(deps.getCatalog(), env, cwd);
    } catch (error) {
      supervisor.fail(`設定が不正: ${(error as Error).message}`);
      applyAttribution(null, 0);
      retireOverlay();
      return;
    }
    const { capture } = resolved;
    if (capture) {
      aggregation ??= createAggregation(capture.maxDestinations, capture.homeCountry, capture.dnsTtlMs);
      homeCountry = capture.homeCountry;
      aggregation.store.setHomeCountry(homeCountry);
      detect = resolved.detect;
      applyAttribution(aggregation.store, detect.ownerPollMs);
      // 一覧はキャプチャする拠点だけが書く (使わない拠点やテストで data/ にファイルを作らない)。
      applyOverlay(resolved.overlay);
      supervisor.reconcile(capture, null);
      return;
    }
    supervisor.reconcile(null, resolved.disabledReason);
    applyAttribution(null, 0);
    retireOverlay();
  };

  reconcile();
  const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  // 監視のタイマーだけで Node を生かし続けない (停止は stop() が持つ)。
  reconcileTimer.unref();

  return {
    snapshot,
    recordDnsAnswer: (answer) => aggregation?.ingest.recordDns(answer, now()),
    stop: () => {
      clearInterval(reconcileTimer);
      supervisor.stop();
      applyAttribution(null, 0);
      retireOverlay();
    },
  };
}
