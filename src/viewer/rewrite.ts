import { randomBytes } from 'node:crypto';
import type { ViewerTarget } from './catalog.js';
import { viewerUrl } from './urls.js';

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function allowBootstrap(policy: string, nonce: string): string {
  const directives = policy.split(';').map((part) => part.trim()).filter(Boolean);
  const defaultSource = directives.find((part) => part.startsWith('default-src '));
  if (!directives.some((part) => part.startsWith('script-src ')) && defaultSource) {
    directives.push(defaultSource.replace(/^default-src/, 'script-src'));
  }
  return directives.map((part) => /^script-src(?:-elem)?\s/.test(part)
    ? `${part.replace(/\s'none'(?=\s|$)/g, '')} 'nonce-${nonce}'` : part).join('; ');
}

export function rewriteCss(text: string, target: ViewerTarget): string {
  return text.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi,
    (_all, quote: string, value: string) => `url(${quote}${viewerUrl(value, target)}${quote})`);
}

interface StringSpan { start: number; end: number }

function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return text.length;
}

function skipTrivia(text: string, start: number): number {
  let index = start;
  for (;;) {
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text.startsWith('//', index)) {
      index = text.indexOf('\n', index + 2);
      if (index < 0) return text.length;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else return index;
  }
}

function quotedSpan(text: string, start: number): StringSpan | null {
  if (text[start] !== '"' && text[start] !== "'") return null;
  const end = stringEnd(text, start);
  return end <= text.length && text[end - 1] === text[start] ? { start: start + 1, end: end - 1 } : null;
}

function fromSpecifier(text: string, start: number): StringSpan | null {
  let index = start;
  while (index < text.length && text[index] !== ';') {
    index = skipTrivia(text, index);
    if (text[index] === '"' || text[index] === "'" || text[index] === '`') {
      index = stringEnd(text, index);
      continue;
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
    if (match) {
      index += match[0].length;
      if (match[0] === 'from') return quotedSpan(text, skipTrivia(text, index));
    } else index += 1;
  }
  return null;
}

/** Rewrite actual module specifiers while leaving strings and comments untouched. */
export function rewriteModules(text: string, target: ViewerTarget): string {
  const spans: StringSpan[] = [];
  let index = 0;
  while (index < text.length) {
    index = skipTrivia(text, index);
    if (text[index] === '"' || text[index] === "'" || text[index] === '`') {
      index = stringEnd(text, index);
      continue;
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
    if (!match) { index += 1; continue; }
    const keyword = match[0];
    const keywordStart = index;
    index += keyword.length;
    let previous = keywordStart - 1;
    while (previous >= 0 && /\s/.test(text[previous] ?? '')) previous -= 1;
    if (!['import', 'export'].includes(keyword) || text[previous] === '.') continue;
    const next = skipTrivia(text, index);
    let span: StringSpan | null = null;
    if (keyword === 'import' && text[next] === '(') span = quotedSpan(text, skipTrivia(text, next + 1));
    else if (keyword === 'import') span = quotedSpan(text, next) ?? fromSpecifier(text, next);
    else span = fromSpecifier(text, next);
    if (span) spans.push(span);
  }
  let rewritten = text;
  for (const span of spans.reverse()) {
    const value = text.slice(span.start, span.end);
    if (value.startsWith('/') && !value.startsWith('//')) {
      rewritten = rewritten.slice(0, span.start) + viewerUrl(value, target) + rewritten.slice(span.end);
    }
  }
  return rewritten;
}

function rewriteTag(tag: string, target: ViewerTarget, nonce: string): string {
  let rewritten = tag.replace(/\b(src|href|action|poster)\s*=\s*(["'])(.*?)\2/gi,
    (_all, name: string, quote: string, value: string) => `${name}=${quote}${viewerUrl(value, target)}${quote}`);
  rewritten = rewritten.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi,
    (_all, quote: string, value: string) => `style=${quote}${rewriteCss(value, target)}${quote}`);
  if (/^<meta\b/i.test(rewritten)
    && /\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/i.test(rewritten)) {
    rewritten = rewritten.replace(/(\bcontent\s*=\s*)(["'])(.*?)\2/i,
      (_all, lead: string, quote: string, policy: string) => `${lead}${quote}${allowBootstrap(policy, nonce)}${quote}`);
  }
  return rewritten;
}

export function rewriteHtml(text: string, target: ViewerTarget, headers: Headers): string {
  const nonce = randomBytes(18).toString('base64');
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const policy = headers.get(name);
    if (policy) headers.set(name, allowBootstrap(policy, nonce));
  }
  const scripts: string[] = [];
  let html = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_all, open: string, script: string, close: string) => {
    const marker = `\0EX_VIEWER_SCRIPT_${scripts.length}\0`;
    scripts.push(script);
    return rewriteTag(open, target, nonce) + marker + close;
  });
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_all, open: string, css: string, close: string) => rewriteTag(open, target, nonce) + rewriteCss(css, target) + close);
  html = html.replace(/<[^!][^>]*>/g, (tag) => rewriteTag(tag, target, nonce));
  const attributes = `data-excubitor-viewer data-prefix="${escapeAttribute(target.prefix)}" data-origins="${escapeAttribute(JSON.stringify(target.origins))}"`;
  const bootstrap = `<script nonce="${nonce}" ${attributes} src="/viewer/storage.js"></script>`
    + `<script nonce="${nonce}" ${attributes} src="/viewer/runtime.js"></script>`;
  html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => head + bootstrap) : bootstrap + html;
  return html.replace(/\0EX_VIEWER_SCRIPT_(\d+)\0/g, (_all, index: string) => scripts[Number(index)] ?? '');
}
