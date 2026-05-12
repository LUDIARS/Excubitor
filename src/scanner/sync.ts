import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { listContainers, type DockerContainer } from './docker.js';
import { type Catalog, type Service } from '../catalog/loader.js';
import { readGitInfo, type GitInfo } from './git.js';
import { getOrCreateLocalHost, heartbeatLocalHost } from './host.js';

/**
 * docker scan の結果と catalog を突き合わせて service_instances を更新。
 *
 * v0.1: docker (compose 含む) のみ。 node / dev-process-md は ProcessManager 実装後に対応。
 *       git / package_version は catalog の cwd を見て同時に取得。
 */
export async function syncDockerInstances(catalog: Catalog): Promise<{
  scanned: number;
  matched: number;
}> {
  const containers = await listContainers();
  const byName = new Map<string, DockerContainer>();
  for (const c of containers) {
    for (const n of c.names) byName.set(n, c);
  }

  const hostId = await getOrCreateLocalHost();
  await heartbeatLocalHost();

  let matched = 0;
  for (const svc of catalog.services) {
    if (svc.runtime !== 'docker-compose' && svc.runtime !== 'docker') continue;
    if (!svc.container_names || svc.container_names.length === 0) continue;

    const state = inferState(svc, byName);
    // git 取得対象 cwd: catalog.cwd 優先、 なければ compose_file の親ディレクトリ
    const gitCwd = svc.monitor_only
      ? null
      : (svc.cwd ?? (svc.compose_file ? dirname(svc.compose_file) : null));
    const git: GitInfo = gitCwd
      ? await readGitInfo(gitCwd)
      : { branch: null, hash: null, dirty: null, package_version: null };

    await upsertInstance(svc.code, hostId, state.docker_id, state.state, state.detail, git, svc.port ?? null);
    if (state.state !== 'unknown') matched++;
  }

  return { scanned: containers.length, matched };
}

function inferState(
  svc: Service,
  byName: Map<string, DockerContainer>,
): { docker_id: string | null; state: string; detail: Record<string, unknown> } {
  const found = svc.container_names!.map((n) => byName.get(n)).filter(Boolean) as DockerContainer[];

  if (found.length === 0) {
    return { docker_id: null, state: 'stopped', detail: { reason: 'no container matched' } };
  }

  // 全部 running なら running、 1 つでも止まってれば degraded を unhealthy 扱い、
  // 全部 exited なら stopped
  const states = found.map((c) => c.state);
  const allRunning = states.every((s) => s === 'running');
  const allExited = states.every((s) => s === 'exited' || s === 'dead' || s === 'created');
  let unified: string;
  if (allRunning) unified = 'running';
  else if (allExited) unified = 'stopped';
  else unified = 'degraded';

  return {
    docker_id: found[0]!.id,
    state: unified,
    detail: {
      containers: found.map((c) => ({
        id: c.id,
        names: c.names,
        state: c.state,
        status: c.status,
      })),
    },
  };
}

/**
 * service_instance の upsert。
 * v0.1 は service per host を 1 件と仮定し、 (service_id, host_id) を unique key として扱う。
 */
async function upsertInstance(
  serviceCode: string,
  hostId: string,
  dockerId: string | null,
  state: string,
  detail: Record<string, unknown>,
  git: GitInfo,
  port: number | null,
): Promise<void> {
  await db.execute(sql`
    WITH svc AS (
      SELECT id FROM services WHERE code = ${serviceCode} AND is_active = TRUE
    ),
    existing AS (
      SELECT si.id
      FROM service_instances si, svc
      WHERE si.service_id = svc.id AND si.host_id = ${hostId}
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO service_instances (
        service_id, host_id, docker_id, state, last_seen_at,
        git_branch, git_hash, git_dirty, package_version, port
      )
      SELECT svc.id, ${hostId}, ${dockerId}, ${state}, now(),
             ${git.branch}, ${git.hash}, ${git.dirty}, ${git.package_version}, ${port}
      FROM svc
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    ),
    updated AS (
      UPDATE service_instances
      SET docker_id = ${dockerId},
          state = ${state},
          last_seen_at = now(),
          git_branch = ${git.branch},
          git_hash = ${git.hash},
          git_dirty = ${git.dirty},
          package_version = ${git.package_version},
          port = ${port},
          updated_at = now()
      WHERE id IN (SELECT id FROM existing)
      RETURNING id
    )
    INSERT INTO liveness_history (service_instance_id, ok, detail)
    SELECT COALESCE((SELECT id FROM inserted), (SELECT id FROM updated)),
           ${state === 'running'},
           ${JSON.stringify(detail)}::jsonb
  `);
}
