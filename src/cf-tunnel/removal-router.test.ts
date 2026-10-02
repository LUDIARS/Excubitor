import { describe, expect, it } from 'vitest';
import { buildCfRemovalRouter } from './removal-router.js';

const post = (path: string, body: unknown) =>
  buildCfRemovalRouter().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 入力の不備は CF に問い合わせる前に 400 で返す (資格情報の解決にも進まない)。
describe('CF removal API input validation', () => {
  it('dns/remove は hostname が必須', async () => {
    expect((await post('/api/v1/cf-tunnel/dns/remove', {})).status).toBe(400);
  });

  it('tunnels/remove は tunnel の明示が必須 (唯一の tunnel の暗黙指定を使わない)', async () => {
    const response = await post('/api/v1/cf-tunnel/tunnels/remove', { confirm: 'ludiars-local' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('bad_request');
  });
});
