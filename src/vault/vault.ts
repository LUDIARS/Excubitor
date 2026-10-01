/**
 * Vault の操作 (本社: 値と「使用する環境変数」の管理、拠点: 本社から受け取った値の控え)。
 *
 * 平文を返すのは envFor / cachedEnv だけで、呼び出し元はサービス起動時の env 注入
 * (vault-inject.ts) と本社の拠点向け配布 (vault-federation.ts) に限る。管理 API には名前と
 * 更新日時・紐付けしか返さない。
 */

import { createKeyStore, loadOrCreateDek, type KeyStore } from './keystore.js';
import { openValue, sealValue } from './vault-crypto.js';
import { ENV_NAME_PATTERN, readVault, vaultDir, vaultFilePath, writeVault, type VaultDoc } from './vault-store.js';

export interface VaultStatus {
  keystore: KeyStore['kind'];
  source_peer_id: string | null;
  entries: Array<{ name: string; updated_at: number; used_by: string[] }>;
  bindings: Record<string, Array<{ name: string; present: boolean }>>;
  cached_services: Array<{ code: string; fetched_at: number }>;
}

export interface ServiceVaultEnv {
  env: Record<string, string>;
  /** 紐付けてあるのに値が未登録の変数名。 */
  missing: string[];
}

export class VaultError extends Error {
  constructor(readonly code: 'invalid_name' | 'invalid_value' | 'invalid_service', message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultOptions {
  dir?: string;
  keyStore?: KeyStore;
  now?: () => number;
}

const SERVICE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_VALUE_BYTES = 64 * 1024;

export class Vault {
  private readonly dir: string;
  private readonly keyStore: KeyStore;
  private readonly now: () => number;
  private dek: Promise<Buffer> | null = null;

  constructor(options: VaultOptions = {}) {
    this.dir = options.dir ?? vaultDir();
    this.keyStore = options.keyStore ?? createKeyStore(this.dir);
    this.now = options.now ?? Date.now;
  }

  status(): VaultStatus {
    const doc = this.read();
    const usedBy = (name: string) => Object.entries(doc.bindings).filter(([, names]) => names.includes(name)).map(([code]) => code).sort();
    return {
      keystore: this.keyStore.kind,
      source_peer_id: doc.source_peer_id,
      entries: Object.entries(doc.entries)
        .map(([name, entry]) => ({ name, updated_at: entry.updated_at, used_by: usedBy(name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      bindings: Object.fromEntries(Object.entries(doc.bindings).map(([code, names]) => [
        code,
        names.map((name) => ({ name, present: name in doc.entries })),
      ])),
      cached_services: Object.entries(doc.cache)
        .map(([code, cache]) => ({ code, fetched_at: cache.fetched_at }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  async setEntry(name: string, value: string): Promise<void> {
    assertName(name);
    if (typeof value !== 'string' || value.length === 0) throw new VaultError('invalid_value', 'value must be a non-empty string');
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new VaultError('invalid_value', 'value is too large');
    const sealed = sealValue(await this.key(), name, value);
    this.update((doc) => { doc.entries[name] = { sealed, updated_at: this.now() }; });
  }

  /**
   * 複数件をまとめて取り込む (Infisical から)。Vault は変数名の名前空間が 1 つなので、
   * 既にある同名が別の値なら上書きせず conflicts で返す (別 project の同名で他サービスの値を壊さないため)。
   */
  async importEntries(values: Record<string, string>): Promise<{ imported: string[]; unchanged: string[]; conflicts: string[] }> {
    const key = await this.key();
    const names = Object.keys(values).sort();
    for (const name of names) assertName(name);
    const doc = this.read();
    const imported: string[] = [];
    const unchanged: string[] = [];
    const conflicts: string[] = [];
    for (const name of names) {
      const existing = doc.entries[name];
      if (!existing) imported.push(name);
      else if (openValue(key, name, existing.sealed) === values[name]) unchanged.push(name);
      else conflicts.push(name);
    }
    this.update((current) => {
      for (const name of imported) current.entries[name] = { sealed: sealValue(key, name, values[name]!), updated_at: this.now() };
    });
    return { imported, unchanged, conflicts };
  }

  deleteEntry(name: string): boolean {
    let existed = false;
    this.update((doc) => {
      existed = name in doc.entries;
      delete doc.entries[name];
    });
    return existed;
  }

  setBindings(code: string, names: readonly string[]): void {
    if (!SERVICE_CODE_PATTERN.test(code)) throw new VaultError('invalid_service', 'invalid service code');
    for (const name of names) assertName(name);
    const unique = [...new Set(names)].sort();
    this.update((doc) => {
      if (unique.length === 0) delete doc.bindings[code];
      else doc.bindings[code] = unique;
    });
  }

  bindingsFor(code: string): string[] {
    return this.read().bindings[code] ?? [];
  }

  setSourcePeer(peerId: string | null): void {
    this.update((doc) => { doc.source_peer_id = peerId; });
  }

  sourcePeerId(): string | null {
    return this.read().source_peer_id;
  }

  /** 本社: サービスに紐付けた変数の値。紐付けが無ければ null。 */
  async envFor(code: string): Promise<ServiceVaultEnv | null> {
    const doc = this.read();
    const names = doc.bindings[code];
    if (!names || names.length === 0) return null;
    const key = await this.key();
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const entry = doc.entries[name];
      if (entry) env[name] = openValue(key, name, entry.sealed);
      else missing.push(name);
    }
    return { env, missing };
  }

  /** 拠点: 本社から受け取った値を控える。 */
  async cacheEnv(code: string, env: Record<string, string>): Promise<void> {
    const key = await this.key();
    const sealed = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, sealValue(key, cacheAad(code, name), value)]));
    this.update((doc) => { doc.cache[code] = { env: sealed, fetched_at: this.now() }; });
  }

  async cachedEnv(code: string): Promise<{ env: Record<string, string>; fetched_at: number } | null> {
    const cached = this.read().cache[code];
    if (!cached) return null;
    const key = await this.key();
    return {
      env: Object.fromEntries(Object.entries(cached.env).map(([name, sealed]) => [name, openValue(key, cacheAad(code, name), sealed)])),
      fetched_at: cached.fetched_at,
    };
  }

  private key(): Promise<Buffer> {
    this.dek ??= loadOrCreateDek(this.keyStore).catch((error: unknown) => {
      this.dek = null;
      throw error;
    });
    return this.dek;
  }

  private read(): VaultDoc {
    return readVault(vaultFilePath(this.dir));
  }

  private update(mutate: (doc: VaultDoc) => void): void {
    const doc = this.read();
    mutate(doc);
    writeVault(doc, vaultFilePath(this.dir));
  }
}

function assertName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) throw new VaultError('invalid_name', `invalid environment variable name: ${name}`);
}

/** 控えは本社の値と取り違えないよう AAD にサービスコードを含める。 */
function cacheAad(code: string, name: string): string {
  return `cache:${code}:${name}`;
}

let shared: Vault | null = null;

/** プロセス内で共有する Vault (鍵の復号を 1 回にする)。 */
export function sharedVault(): Vault {
  shared ??= new Vault();
  return shared;
}
