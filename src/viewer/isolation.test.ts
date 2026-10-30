import { describe, expect, it } from 'vitest';
import type { ViewerTarget } from './catalog.js';
import { isCrossAppRequest } from './isolation.js';
import { upstreamHeaders, viewerHeaders } from './headers.js';
import { rewriteHtml } from './rewrite.js';

const target: ViewerTarget = {
  code: 'b', prefix: '/viewer/apps/b', upstream: new URL('http://app.invalid/'),
  origins: { 'http://127.0.0.1:4100': '/viewer/apps/b-api' },
};
const site = 'https://viewer.example.com';
const headers = (values: Record<string, string>): Headers => new Headers(values);

/** @implements EX-VIEWER-DMZ */
describe('Viewer cross-app containment (same origin)', () => {
  it('treats requests from another app page, or with the referrer stripped, as cross-app', () => {
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', referer: `${site}/viewer/apps/a/` }), target)).toBe(true);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), target)).toBe(true);
    // A prefix that merely starts with the same letters is another app.
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', referer: `${site}/viewer/apps/bb/` }), target)).toBe(true);
    // Form navigation from another app is cross-app too.
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', referer: `${site}/viewer/apps/a/x` }), target)).toBe(true);
  });

  it('keeps the app itself, its project peers, the viewer top page and user-initiated requests working', () => {
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', referer: `${site}/viewer/apps/b/page` }), target)).toBe(false);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', referer: `${site}/viewer/apps/b-api/` }), target)).toBe(false);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', referer: `${site}/viewer/` }), target)).toBe(false);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', referer: `${site}/viewer/apps/excubitor/` }), target)).toBe(false);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }), target)).toBe(false);
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'cross-site' }), target)).toBe(false);
    // Fetches from the viewer top page itself are not navigations into the app.
    expect(isCrossAppRequest(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', referer: `${site}/viewer/` }), target)).toBe(true);
  });

  it('forwards no app cookie for a cross-app request', () => {
    const encoded = Buffer.from('session').toString('base64url');
    const incoming = headers({ cookie: `exv_b.${encoded}=secret` });
    expect(upstreamHeaders(incoming, target).get('cookie')).toBe('session=secret');
    expect(upstreamHeaders(incoming, target, { forwardCookies: false }).has('cookie')).toBe(false);
  });

  it('keeps Referer on app requests so they stay attributable', () => {
    expect(viewerHeaders(headers({ 'referrer-policy': 'no-referrer' }), target).get('referrer-policy')).toBe('same-origin');
    const html = rewriteHtml('<html><head><meta name="referrer" content="no-referrer"></head></html>', target, new Headers());
    expect(html).toContain('<meta name="referrer" content="same-origin">');
  });
});
