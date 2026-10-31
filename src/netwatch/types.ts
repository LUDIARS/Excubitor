/** @implements SPEC-EX-NETWATCH */
/**
 * 通信監視 (netwatch) の値型。 tshark の 1 行 (= 1 パケット) から取り出した観測と、
 * 通信先ごとの集計を表す。 ペイロードは扱わず、 宛先・ドメイン・国だけを持つ。
 */

/** 観測の種類。 どのプロトコルの何から通信先を知ったか。 */
export type ObservationKind = 'dns' | 'tls' | 'quic' | 'http' | 'syn';

/** DNS 応答 1 件で分かった「名前 → アドレス」の対応。 */
export interface DnsAnswer {
  name: string;
  addresses: string[];
}

/** この PC 側の端点 (送信元プロセスを OS の接続表から引く鍵)。 */
export interface LocalEndpoint {
  transport: 'tcp' | 'udp';
  port: number;
}

/** 通信を出したプロセス。 name / service は分かったときだけ。 */
export interface TrafficOwner {
  pid: number;
  /** 実行ファイル名。 プロセス一覧に無ければ null。 */
  name: string | null;
  /** Excubitor が起動したサービス (とその子孫) なら、 その catalog code。 */
  service: string | null;
}

/** tshark の 1 行から取り出した観測。 */
export interface PacketObservation {
  kind: ObservationKind;
  /** パケットの時刻 (epoch ms)。 */
  atMs: number;
  /** 自分側から見た通信先アドレス。 DNS 応答のときは問い合わせ先 (DNS サーバ)。 */
  remote: string;
  /** 通信先ポート。 取れないときは null。 */
  port: number | null;
  /** SNI / HTTP Host から直接分かった名前。 */
  serverName: string | null;
  /** DNS 応答の内容 (kind=dns のときだけ)。 */
  dns: DnsAnswer | null;
  /** Wireshark の MaxMind 解決で付いた宛先の国 (ISO 3166-1 alpha-2)。 未設定・不明なら null。 */
  country: string | null;
  /** この PC 側の端点。 ポートが取れないときは null。 */
  local: LocalEndpoint | null;
}

/** 宛先アドレスの範囲。 public 以外は国を問わない。 */
export type AddressScope = 'public' | 'private' | 'loopback' | 'link-local' | 'multicast' | 'unspecified';

/** 国外判定の結果。 */
export type Locality = 'foreign' | 'domestic' | 'local' | 'unknown';

/** 通信先 (アドレス単位) の集計。 */
export interface Destination {
  remote: string;
  scope: AddressScope;
  country: string | null;
  locality: Locality;
  /** この宛先に付いたドメイン (SNI / Host / DNS 応答)。 新しいものが先頭。 */
  domains: string[];
  ports: number[];
  kinds: ObservationKind[];
  firstSeenMs: number;
  lastSeenMs: number;
  packets: number;
  /** この宛先へ通信したプロセス。 新しいものが先頭。 特定できなければ空。 */
  owners: TrafficOwner[];
}

/** 怪しいとした理由。 国外であることは理由にしない。 */
export type SuspicionReason = 'direct-ip' | 'unusual-port';

/** 一覧と API に出す判定。 */
export interface DestinationAssessment {
  /** 通信したプロセスがすべてサービスなら、 その code (重複なし)。 1 つでもサービス以外か不明なら空。 */
  services: string[];
  reasons: SuspicionReason[];
}

export type AssessedDestination = Destination & { assessment: DestinationAssessment };

/** キャプチャの状態。 API と Tela の一覧に出す。 */
export type CaptureState = 'disabled' | 'starting' | 'running' | 'backoff' | 'failed';

export interface CaptureStatus {
  state: CaptureState;
  /** 失敗・待機の理由 (tshark が無い、 権限が無いなど)。 */
  reason: string | null;
  pid: number | null;
  startedAtMs: number | null;
  /** 直近の stderr (tshark の警告やエラー)。 */
  stderrTail: string[];
  /** 公開アドレス宛ての観測のうち国が付かなかった数。 GeoIP 未設定の手がかり。 */
  publicWithoutCountry: number;
  publicObserved: number;
}
