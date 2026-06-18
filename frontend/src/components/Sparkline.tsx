/** RSS 時系列の極小スパークライン (SVG)。 値域を縦に正規化して polyline を描く。 */
export default function Sparkline({
  points,
  width = 160,
  height = 36,
  color = '#60a5fa',
}: {
  points: Array<{ t: number; rss: number }>;
  width?: number;
  height?: number;
  color?: string;
}) {
  if (points.length < 2) {
    return <svg width={width} height={height} className="sparkline" aria-label="no data" />;
  }
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.rss);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const pad = 2;
  const coords = points.map((p) => {
    const x = pad + ((p.t - minX) / spanX) * (width - pad * 2);
    const y = height - pad - ((p.rss - minY) / spanY) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="sparkline" preserveAspectRatio="none">
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
