/** Vault 管理 API のクライアント。値を読む口は無い (書く・消す・紐付けるだけ)。 */

export interface VaultStatus {
  keystore: 'dpapi' | 'file';
  source_peer_id: string | null;
  entries: Array<{ name: string; updated_at: number; used_by: string[] }>;
  bindings: Record<string, Array<{ name: string; present: boolean }>>;
  cached_services: Array<{ code: string; fetched_at: number }>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const fetchVaultStatus = () => send<VaultStatus>('GET', '/api/v1/vault');
export const saveVaultEntry = (name: string, value: string) =>
  send<{ ok: true }>('PUT', `/api/v1/vault/entries/${encodeURIComponent(name)}`, { value });
export const deleteVaultEntry = (name: string) =>
  send<{ ok: true }>('DELETE', `/api/v1/vault/entries/${encodeURIComponent(name)}`);
export const saveVaultBindings = (code: string, names: string[]) =>
  send<{ ok: true }>('PUT', `/api/v1/vault/bindings/${encodeURIComponent(code)}`, { names });
export const saveVaultSource = (peerId: string | null) =>
  send<{ ok: true }>('PUT', '/api/v1/vault/source', { peer_id: peerId });
export const importVaultFromInfisical = (code: string) =>
  send<{ ok: true; imported: string[] }>('POST', `/api/v1/vault/import/infisical/${encodeURIComponent(code)}`);
