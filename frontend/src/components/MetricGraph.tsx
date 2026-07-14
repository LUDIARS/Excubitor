/**
 * ラベル付きの極小メトリクスグラフ (稼働率 / CPU / メモリ)。
 * points は {t, v} の時系列。 縦に正規化して polyline を描き、 ラベルと最新値を添える。
 */
export default function MetricGraph({
  label,
  value,
  points,
  color,
  width = 92,
  height = 30,
}: {
  label: string;
  value: string;
  points: Array<{ t: number; v: number }>;
  color: string;
  width?: number;
  height?: number;
}) {
  return (
    <div className="metric-graph" title={`${label}: ${value}`}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className="metric-value">{value}</span>
      </div>
      {points.length < 2 ? (
        <svg width={width} height={height} className="sparkline" aria-label="no data" />
      ) : (
        <Line points={points} color={color} width={width} height={height} />
      )}
    </div>
  );
}

function Line({
  points, color, width, height,
}: { points: Array<{ t: number; v: number }>; color: string; width: number; height: number }) {
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.v);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const pad = 2;
  const coords = points.map((p) => {
    const x = pad + ((p.t - minX) / spanX) * (width - pad * 2);
    const y = height - pad - ((p.v - minY) / spanY) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="sparkline" preserveAspectRatio="none">
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
