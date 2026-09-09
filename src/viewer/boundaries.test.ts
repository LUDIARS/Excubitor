import { describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { exclusionReason, type ViewerTarget } from './catalog.js';
import { upstreamRequestUrl, viewerUrl } from './urls.js';
import { upstreamHeaders, viewerHeaders } from './headers.js';
import { rewriteHtml, rewriteModules } from './rewrite.js';

const target: ViewerTarget = {
  code: 'example', prefix: '/viewer/apps/example', upstream: new URL('http://app.invalid/'),
  origins: { 'http://app.invalid': '/viewer/apps/example' },
};

function service(fields: Partial<Service>): Service {
  return { code: 'example', name: 'Example', runtime: 'node', required_env: [], disabled: false,
    develop_derived: false, monitor_only: false, depends_on: [], autostart: false,
    allow_hot_reload: false, restart_policy: 'no', max_restart: 5, ...fields };
}

describe('Viewer boundaries (no network)', () => {
  it('never resolves a request path as a new authority', () => {
    const result = upstreamRequestUrl('http://viewer.invalid/viewer/apps/example//other.invalid/private?q=1', target);
    expect(result.origin).toBe('http://app.invalid');
    expect(result.pathname).toBe('//other.invalid/private');
    expect(result.search).toBe('?q=1');
    expect(() => upstreamRequestUrl('http://viewer.invalid/viewer/apps/example/%2fother.invalid', target)).toThrow();
  });

  it('does not duplicate a declared upstream base path', () => {
    const based = { ...target, upstream: new URL('http://app.invalid/base/') };
    expect(upstreamRequestUrl('http://viewer.invalid/viewer/apps/example/base/assets/app.js', based).pathname)
      .toBe('/base/assets/app.js');
    expect(upstreamRequestUrl('http://viewer.invalid/viewer/apps/example/api/items', based).pathname)
      .toBe('/base/api/items');
  });

  it('preserves nested relative references and external URLs', () => {
    expect(viewerUrl('../assets/image.png', target)).toBe('../assets/image.png');
    expect(viewerUrl('https://external.invalid/login', target)).toBe('https://external.invalid/login');
    expect(viewerUrl('/api/items?q=1#x', target)).toBe('/viewer/apps/example/api/items?q=1#x');
    expect(viewerUrl('/viewer/apps/example/api', target)).toBe('/viewer/apps/example/api');
  });

  it('does not rewrite arbitrary JavaScript strings', () => {
    expect(rewriteModules('const root="/"; const text=\'import("/private")\'; '
      + 'export { value } from "/exports.js"; import("/assets/chunk.js")', target))
      .toBe('const root="/"; const text=\'import("/private")\'; '
        + 'export { value } from "/viewer/apps/example/exports.js"; '
        + 'import("/viewer/apps/example/assets/chunk.js")');
    const html = rewriteHtml('<html><head><style>.x{background:url(/image.png)}</style></head>'
      + '<body><script src="/app.js">const value="url(/api)"; const html="href=\\"/private\\"";</script>'
      + '<a href="/page" style="background:url(/tile.png)">url(/text)</a></body></html>', target, new Headers());
    expect(html).toContain('const value="url(/api)"; const html="href=\\"/private\\"";');
    expect(html).toContain('src="/viewer/apps/example/app.js"');
    expect(html).toContain('<style>.x{background:url(/viewer/apps/example/image.png)}</style>');
    expect(html).toContain('href="/viewer/apps/example/page"');
    expect(html).toContain('style="background:url(/viewer/apps/example/tile.png)"');
    expect(html).toContain('>url(/text)</a>');
  });

  it('namespaces cookies while preserving path, HttpOnly and the original name upstream', () => {
    const response = viewerHeaders(new Headers({ 'set-cookie': 'session=app; Path=/api; HttpOnly; Secure' }), target);
    const encoded = Buffer.from('session').toString('base64url');
    expect(response.get('set-cookie')).toContain(`exv_example.${encoded}=app; Path=/viewer/apps/example/api;`);
    expect(response.get('set-cookie')).toContain('HttpOnly');
    const forwarded = upstreamHeaders(new Headers({
      cookie: `ex-session=private; exv_example.${encoded}=app; exv_other.${encoded}=other; exv_example_child.${encoded}=child`,
      origin: 'https://viewer.invalid', 'x-forwarded-for': '127.0.0.1', authorization: 'Bearer ingress-secret',
    }), target);
    expect(forwarded.get('cookie')).toBe('session=app');
    expect(forwarded.get('origin')).toBe('https://viewer.invalid');
    expect(forwarded.has('x-forwarded-for')).toBe(false);
    expect(forwarded.has('authorization')).toBe(false);
  });

  it.each(['actio', 'actio-web', 'interpres-worldpos', 'ludellus-web', 'glab', 'corpus'])
    ('excludes %s even if a web entry is declared', (code) => {
      expect(exclusionReason(service({ code, frontend_url: 'http://app.invalid/' }), new Map())).not.toBeNull();
    });

  it('requires an explicit same-origin trust opt-in', () => {
    expect(exclusionReason(service({ frontend_port: 3000 }), new Map())).toBe('Viewer対象外');
    expect(exclusionReason(service({ frontend_port: 3000,
      viewer: { enabled: true, entry_path: '/', loopback_required: false } }), new Map())).toBeNull();
  });

  it('excludes declared and preference-based Corpus hubs and explicit loopback requirements', () => {
    expect(exclusionReason(service({ uses_corpus: true }), new Map())).toBe('Corpus系');
    expect(exclusionReason(service({ code: 'custom' }), new Map([['custom', true]]))).toBe('Corpus系');
    expect(exclusionReason(service({ env: { CORPUS_PUBLIC_URL: 'https://hub.invalid' } }), new Map())).toBe('Corpus系');
    expect(exclusionReason(service({ viewer: { enabled: true, entry_path: '/', loopback_required: true } }), new Map())).toBe('ループバック接続が必要');
  });
});
