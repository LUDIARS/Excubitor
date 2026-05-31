import { useEffect, useState } from 'react';
import { subscribeLogs } from '../lib/api';

export default function LogsDrawer({ code, onClose }: { code: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => subscribeLogs(code, (l) => setLines((prev) => [...prev.slice(-200), `[${l.ts}] ${l.line}`])), [code]);
  return <div><button onClick={onClose}>close</button><pre>{lines.join('\n')}</pre></div>;
}
