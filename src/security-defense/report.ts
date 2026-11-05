import type { DayData } from './store.js';

/** Counts are observations, not a verdict of compromise. Content is bounded for Discord. */
export function dailyMessage(site: string, data: DayData): string {
  const requests = data.counts.reduce((n, r) => n + r.count, 0);
  const denied = data.counts.filter(r => r.action === 'deny').reduce((n, r) => n + r.count, 0);
  const gaps = data.coverage.filter(r => r.state !== 'healthy');
  const net = data.findings.filter(r => r.rule.startsWith('network_'));
  const top = (prefix: string): string => data.metrics.filter(m => m.name.startsWith(prefix)).slice(0, 4)
    .map(m => `${m.name.slice(prefix.length)}=${m.value}`).join(', ') || '記録なし';
  const lines = [
    `Ex 防衛デイリーレポート ${data.day} (JST) / ${site}`,
    `HTTP記録: ${requests}件 / 拒否: ${denied}件（拒否数＝攻撃数ではありません）`,
    'HTTP内訳: ' + (data.counts.slice(0, 4).map(r => `${r.service}:${r.reason}/${r.status}=${r.count}`).join(', ').slice(0, 300) || '記録なし・安全判定不可'),
    '検知: ' + (data.findings.filter(r => !r.rule.startsWith('network_')).slice(0, 5).map(r => `${r.rule}=${r.count}`).join(', ') || '記録された兆候なし'),
    `tshark: 要確認の通信先 ${net.length}件（同じ通信先はまとめています）`,
    `tshark観測数: ${data.metrics.find(m => m.name === 'network_observed_packets')?.value ?? 0} / プロセス不明: ${data.metrics.find(m => m.name === 'network_unattributed_packets')?.value ?? 0}`,
    '国別: ' + top('network_country_'),
    '関連ポート: ' + top('network_port_'),
    '関連プロセス: ' + top('network_owner_').slice(0, 200),
    '通信内訳: ' + (net.slice(0, 2).map(r => `${r.rule} / ${r.asset}`).join(', ') || '要確認記録なし。収集状態を確認してください'),
    '監視範囲: ' + (data.coverage.filter(r => r.state === 'healthy').map(r => `${r.source}:${r.count}回`).join(', ').slice(0, 180) || '観測なし'),
    '不足: ' + (gaps.map(r => `${r.source}=${r.state}`).join(', ').slice(0, 280) || '記録上の失敗なし'),
    'tsharkは選択フィールドの観測差分です。ポート・プロセスは宛先への関連付けで重複し、厳密な通信量ではありません。',
    'CF側遮断・キャッシュ・他拠点は未収集。周期観測の間の変化は捕捉できない場合があります。',
    '侵入なしの証明ではありません。詳細・配信状態はExのdefense/reportsで確認できます。',
  ];
  const footer = lines.slice(-2).join('\n');
  return lines.slice(0, -2).join('\n').slice(0, 1950 - footer.length - 1) + '\n' + footer;
}
