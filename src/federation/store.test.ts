import { describe, it, expect } from 'vitest';
import { toView, type RemotePeer } from './store.js';

const base: RemotePeer = {
  id: 'p1',
  name: '自宅',
  base_url: 'https://host:17332',
  token: 'abcdef0123456789',
  cf_access_id: null,
  cf_access_secret: null,
  enabled: true,
  last_ok_at: 1700000000000,
  last_error: null,
  created_at: 1,
  updated_at: 2,
};

describe('toView', () => {
  it('token は末尾 4 文字 hint だけにして full token を漏らさない', () => {
    const v = toView(base);
    expect(v.token_hint).toBe('…6789');
    expect((v as unknown as Record<string, unknown>).token).toBeUndefined();
  });

  it('短い token は伏字', () => {
    expect(toView({ ...base, token: 'ab' }).token_hint).toBe('****');
  });

  it('その他フィールドはそのまま', () => {
    const v = toView(base);
    expect(v).toMatchObject({ id: 'p1', name: '自宅', base_url: 'https://host:17332', enabled: true });
  });

  it('CF Access: id はそのまま、 secret は hint のみで full を漏らさない', () => {
    const v = toView({ ...base, cf_access_id: 'svc-token.access', cf_access_secret: 'sekret-9999' });
    expect(v.cf_access_id).toBe('svc-token.access');
    expect(v.cf_secret_hint).toBe('…9999');
    expect((v as unknown as Record<string, unknown>).cf_access_secret).toBeUndefined();
  });

  it('CF Access 未設定なら id/hint は null', () => {
    const v = toView(base);
    expect(v.cf_access_id).toBeNull();
    expect(v.cf_secret_hint).toBeNull();
  });
});
