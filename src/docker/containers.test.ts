import { describe, it, expect } from 'vitest';
import { toDockerContainer, formatPorts } from './containers.js';

describe('toDockerContainer', () => {
  it('Names の先頭スラッシュを除去し state を小文字化', () => {
    const c = toDockerContainer({ Id: 'abc', Names: ['/cernere-db-1', '/alias'], Image: 'postgres', State: 'Running', Status: 'Up 2 min', Ports: [] });
    expect(c).toEqual({ id: 'abc', names: ['cernere-db-1', 'alias'], image: 'postgres', state: 'running', status: 'Up 2 min', ports: '' });
  });
});

describe('formatPorts', () => {
  it('docker ps と同じ表記', () => {
    expect(formatPorts([
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 15432, Type: 'tcp' },
      { PrivatePort: 6379, Type: 'tcp' },
    ])).toBe('0.0.0.0:15432->5432/tcp, 6379/tcp');
  });
});
