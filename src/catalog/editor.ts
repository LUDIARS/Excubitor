import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

export interface CatalogInfoPatch {
  project_code?: string | null;
  subdomain?: string | null;
  frontend_url?: string | null;
  domain?: string | null;
}

const EDITABLE_KEYS = ['project_code', 'subdomain', 'frontend_url', 'domain'] as const;
type EditableKey = typeof EDITABLE_KEYS[number];

export function updateServiceCatalogInfo(
  code: string,
  patch: CatalogInfoPatch,
  path = 'catalog/services.yaml',
): { code: string; updated: Record<EditableKey, string | null> } {
  const absPath = resolve(process.cwd(), path);
  const raw = readFileSync(absPath, 'utf8');
  const doc = (load(raw) ?? {}) as { services?: Array<{ code?: string }> };
  if (!doc.services?.some((s) => s.code === code)) {
    throw new Error(`service not found in catalog: ${code}`);
  }

  const lines = raw.split(/\r?\n/);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = findServiceBlock(lines, code);
  if (!block) throw new Error(`service block not found in catalog: ${code}`);

  const values = normalizePatch(patch);
  let blockLines = lines.slice(block.start, block.end);
  for (const key of EDITABLE_KEYS) {
    if (!(key in values)) continue;
    blockLines = setBlockScalar(blockLines, key, values[key]);
  }

  lines.splice(block.start, block.end - block.start, ...blockLines);
  writeFileSync(absPath, lines.join(newline), 'utf8');
  return { code, updated: values };
}

function normalizePatch(patch: CatalogInfoPatch): Record<EditableKey, string | null> {
  const out = {} as Record<EditableKey, string | null>;
  for (const key of EDITABLE_KEYS) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    out[key] = raw == null || raw.trim() === '' ? null : raw.trim();
  }
  return out;
}

function findServiceBlock(lines: string[], code: string): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /^  - code:\s*(.+?)\s*$/.exec(lines[i] ?? '');
    if (!m || parseScalar(m[1] ?? '') !== code) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^  - code:\s*/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

function setBlockScalar(lines: string[], key: EditableKey, value: string | null): string[] {
  const index = lines.findIndex((line, i) => i > 0 && new RegExp(`^    ${key}:`).test(line));
  if (value == null) {
    return index >= 0 ? [...lines.slice(0, index), ...lines.slice(index + 1)] : lines;
  }
  const line = `    ${key}: ${formatScalar(value)}`;
  if (index >= 0) return [...lines.slice(0, index), line, ...lines.slice(index + 1)];

  const afterKey = key === 'project_code' ? 'name' : key === 'subdomain' ? 'project_code' : 'domain';
  const after = lines.findIndex((entry) => new RegExp(`^    ${afterKey}:`).test(entry));
  const insertAt = after >= 0 ? after + 1 : Math.min(2, lines.length);
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)];
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatScalar(value: string): string {
  if (/^[a-zA-Z0-9_.${}:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
