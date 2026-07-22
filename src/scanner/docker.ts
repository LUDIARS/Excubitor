import { spawn } from 'node:child_process';

import { killProcessTree } from '../shared/kill-tree.js';

export interface DockerContainer {
  id: string;
  names: string[];          // 1 コンチE��に褁E�� alias が付くため配�E
  image: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | string;
  status: string;           // "Up 10 minutes", "Exited (0) 3 hours ago" 筁E
  ports: string;
}

/**
 * `docker ps -a --format '{{json .}}'` を呼び出して NDJSON めEparse する、E
 * `--no-trunc` で id をフル取得、E
 *
 * docker ps の Names フィールド�E "/cernere-backend-dev,/cernere-db-1" のように
 * 褁E�� alias がカンマ区刁E��で来ることがある�Eで split する、E
 */
export async function listContainers(): Promise<DockerContainer[]> {
  const stdout = await execDocker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const containers: DockerContainer[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, string>;
      containers.push({
        id: raw.ID ?? '',
        names: (raw.Names ?? '').split(',').map((n) => n.replace(/^\//, '').trim()).filter(Boolean),
        image: raw.Image ?? '',
        state: (raw.State ?? '').toLowerCase(),
        status: raw.Status ?? '',
        ports: raw.Ports ?? '',
      });
    } catch {
      // line broken  Eskip
    }
  }
  return containers;
}

/**
 * `docker` は Rancher backend (WSL) 経由で走るため、 Rancher 不調時に応答が返らず
 * ハングし得る。 タイムアウト無しだと 1 スキャンごとにハングした docker が溜まり、
 * その先の wsl-helper/ConPTY が孤児化して積み上がる (= "無限コンソール" の温床)。
 * タイムアウトでツリーごと reap して溜め込みを断つ。
 */
const DOCKER_SCAN_TIMEOUT_MS = 8000;

function execDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(proc);
      reject(new Error(`docker ${args.join(' ')} timed out after ${DOCKER_SCAN_TIMEOUT_MS}ms`));
    }, DOCKER_SCAN_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}



