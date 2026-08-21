import { describe, expect, it } from 'vitest';
import type { CfIngressRule } from './cloudflare-api.js';
import {
  addRoute,
  describeRoutes,
  isHostnameAllowed,
  readAllowedHostnames,
  removeRoute,
  RouteRejectedError,
} from './route-service.js';

const ALLOWED = ['qs-magiclink.ai-run-do.com'];

function baseIngress(): CfIngressRule[] {
  return [
    { hostname: 'qs.ai-run-do.com', service: 'http://127.0.0.1:17400' },
    {
      hostname: 'qs-magiclink.ai-run-do.com',
      path: '^/v1/invoices/share/[A-Za-z0-9_-]+$',
      service: 'http://127.0.0.1:17400',
      originRequest: { connectTimeout: 10 },
    },
    { service: 'http_status:404' },
  ];
}

describe('readAllowedHostnames', () => {
  it('カンマ区切りを trim + 小文字化して読む', () => {
    const env = { EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES: ' A.example.com , b.example.com ' };
    expect(readAllowedHostnames(env as NodeJS.ProcessEnv)).toEqual(['a.example.com', 'b.example.com']);
  });

  it('未設定は空 (fail-closed)', () => {
    expect(readAllowedHostnames({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('env が無ければ config store 由来の allowlist に fallback する (trim + 小文字化)', () => {
    expect(readAllowedHostnames({} as NodeJS.ProcessEnv, [' C.example.com ', ''])).toEqual([
      'c.example.com',
    ]);
  });

  it('env があれば config store 由来より env が優先される', () => {
    const env = { EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES: 'a.example.com' };
    expect(readAllowedHostnames(env as NodeJS.ProcessEnv, ['c.example.com'])).toEqual([
      'a.example.com',
    ]);
  });
});

describe('addRoute', () => {
  it('catch-all の直前に挿入する', () => {
    const next = addRoute(
      baseIngress(),
      { hostname: 'qs-magiclink.ai-run-do.com', path: '^/v1/invoices/share/assets/', service: 'http://127.0.0.1:17400' },
      ALLOWED,
    );
    expect(next).toHaveLength(4);
    expect(next[2]).toEqual({
      hostname: 'qs-magiclink.ai-run-do.com',
      path: '^/v1/invoices/share/assets/',
      service: 'http://127.0.0.1:17400',
    });
    expect(next[3]).toEqual({ service: 'http_status:404' });
  });

  it('allowlist 外の hostname は拒否する', () => {
    expect(() =>
      addRoute(baseIngress(), { hostname: 'evil.example.com', service: 'http://127.0.0.1:1' }, ALLOWED),
    ).toThrow(/allowlist/);
  });

  it('allowlist が空なら全て拒否する (fail-closed)', () => {
    expect(() =>
      addRoute(baseIngress(), { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://127.0.0.1:17400' }, []),
    ).toThrow(/allowlist/);
  });

  it('同一 hostname+path の重複を拒否する', () => {
    expect(() =>
      addRoute(
        baseIngress(),
        {
          hostname: 'qs-magiclink.ai-run-do.com',
          path: '^/v1/invoices/share/[A-Za-z0-9_-]+$',
          service: 'http://127.0.0.1:17400',
        },
        ALLOWED,
      ),
    ).toThrow(/既に存在/);
  });

  it('catch-all が無い config は変更せずエラー', () => {
    const ingress: CfIngressRule[] = [{ hostname: 'qs.ai-run-do.com', service: 'http://127.0.0.1:17400' }];
    expect(() =>
      addRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://127.0.0.1:17400' }, ALLOWED),
    ).toThrow(/catch-all/);
  });

  it('元配列を破壊しない', () => {
    const ingress = baseIngress();
    addRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://x', path: '/p' }, ALLOWED);
    expect(ingress).toEqual(baseIngress());
  });

  it('末尾以外の hostname 無しエントリを catch-all と誤認しない', () => {
    // 壊れた config: 途中に hostname 無しルールがある。ここを catch-all とみなすと
    // 新ルールが「全部を飲み込むエントリ」の後ろに入って無言で死ぬ。
    const ingress: CfIngressRule[] = [
      { service: 'http_status:503' },
      { hostname: 'qs.ai-run-do.com', service: 'http://127.0.0.1:17400' },
      { service: 'http_status:404' },
    ];
    const next = addRoute(
      ingress,
      { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://127.0.0.1:17400' },
      ALLOWED,
    );
    // 末尾の catch-all の直前 (index 2) に入る。先頭の 503 の直後ではない。
    expect(next[2]).toEqual({
      hostname: 'qs-magiclink.ai-run-do.com',
      service: 'http://127.0.0.1:17400',
    });
    expect(next[3]).toEqual({ service: 'http_status:404' });
  });

  it('末尾が catch-all でなければ変更しない', () => {
    const ingress: CfIngressRule[] = [
      { service: 'http_status:404' },
      { hostname: 'qs.ai-run-do.com', service: 'http://127.0.0.1:17400' },
    ];
    expect(() =>
      addRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://x' }, ALLOWED),
    ).toThrow(/catch-all/);
  });

  it('既存ルールの hostname 前後空白を無視して重複を検出する', () => {
    const ingress: CfIngressRule[] = [
      { hostname: ' qs-magiclink.ai-run-do.com ', path: '/p', service: 'http://127.0.0.1:17400' },
      { service: 'http_status:404' },
    ];
    expect(() =>
      addRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com', path: '/p', service: 'http://x' }, ALLOWED),
    ).toThrow(/既に存在/);
  });
});

describe('removeRoute', () => {
  it('hostname+path 完全一致で削除する', () => {
    const next = removeRoute(
      baseIngress(),
      { hostname: 'qs-magiclink.ai-run-do.com', path: '^/v1/invoices/share/[A-Za-z0-9_-]+$' },
      ALLOWED,
    );
    expect(next).toHaveLength(2);
    expect(next.some((r) => r.hostname === 'qs-magiclink.ai-run-do.com')).toBe(false);
  });

  it('path 不一致は削除しない', () => {
    expect(() =>
      removeRoute(baseIngress(), { hostname: 'qs-magiclink.ai-run-do.com', path: '/other' }, ALLOWED),
    ).toThrow(/一致するルールが無い/);
  });

  it('allowlist 外は拒否する', () => {
    expect(() => removeRoute(baseIngress(), { hostname: 'qs.ai-run-do.com' }, ALLOWED)).toThrow(/allowlist/);
  });

  it('catch-all (hostname 無しの末尾) 自体は削除できない', () => {
    // hostname 無しなので allowlist 判定以前に一致対象から外れる。
    const ingress: CfIngressRule[] = [
      { hostname: 'qs-magiclink.ai-run-do.com', service: 'http://127.0.0.1:17400' },
      { service: 'http_status:404' },
    ];
    const next = removeRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com' }, ALLOWED);
    expect(next).toEqual([{ service: 'http_status:404' }]);
  });

  it('既存ルールの hostname 前後空白を無視して削除する', () => {
    const ingress: CfIngressRule[] = [
      { hostname: ' qs-magiclink.ai-run-do.com ', service: 'http://127.0.0.1:17400' },
      { service: 'http_status:404' },
    ];
    const next = removeRoute(ingress, { hostname: 'qs-magiclink.ai-run-do.com' }, ALLOWED);
    expect(next).toEqual([{ service: 'http_status:404' }]);
  });

  it('入力拒否は RouteRejectedError (router が 400 に振り分ける)', () => {
    expect(() => removeRoute(baseIngress(), { hostname: 'qs.ai-run-do.com' }, ALLOWED)).toThrow(
      RouteRejectedError,
    );
  });
});

describe('describeRoutes', () => {
  it('catch-all は hostname null / mutable false、allowlist 掲載のみ mutable', () => {
    const described = describeRoutes(baseIngress(), ALLOWED);
    expect(described).toEqual([
      { hostname: 'qs.ai-run-do.com', path: null, service: 'http://127.0.0.1:17400', mutable: false },
      {
        hostname: 'qs-magiclink.ai-run-do.com',
        path: '^/v1/invoices/share/[A-Za-z0-9_-]+$',
        service: 'http://127.0.0.1:17400',
        mutable: true,
      },
      { hostname: null, path: null, service: 'http_status:404', mutable: false },
    ]);
  });
});

describe('isHostnameAllowed', () => {
  it('大文字小文字を無視して比較する', () => {
    expect(isHostnameAllowed('QS-Magiclink.AI-RUN-DO.com', ALLOWED)).toBe(true);
  });
});
