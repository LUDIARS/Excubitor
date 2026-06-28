import { describe, it, expect } from 'vitest';
import { toCode, extractPort } from './auto-catalog.js';

describe('toCode', () => {
  it('小文字化し非英数を - に畳む', () => {
    expect(toCode('AdventureCube')).toBe('adventurecube');
    expect(toCode('Memoria Server')).toBe('memoria-server');
    expect(toCode('foo__bar--baz')).toBe('foo-bar-baz');
  });
  it('前後の - を除去', () => {
    expect(toCode('  Hello!  ')).toBe('hello');
  });
});

describe('extractPort', () => {
  it('--port / -p からポートを拾う', () => {
    expect(extractPort('vite --port 5173')).toBe(5173);
    expect(extractPort('next dev -p 3000')).toBe(3000);
  });
  it('PORT= / port: を拾う', () => {
    expect(extractPort('PORT=8889 node server.js')).toBe(8889);
    expect(extractPort('server: { port: 4200 }')).toBe(4200);
  });
  it('妥当なポートが無ければ null', () => {
    expect(extractPort('npm run build')).toBeNull();
    expect(extractPort('id 7')).toBeNull(); // 1 桁は対象外
  });
  it('範囲外 (65536+) は採用しない', () => {
    expect(extractPort('--port 70000')).toBeNull();
  });
});
