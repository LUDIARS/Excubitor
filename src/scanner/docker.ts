import { spawn } from 'node:child_process';

export interface DockerContainer {
  id: string;
  names: string[];          // 1 コンテナに複数 alias が付くため配列
  image: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | string;
  status: string;           // "Up 10 minutes", "Exited (0) 3 hours ago" 等
  ports: string;
}

/**
 * `docker ps -a --format '{{json .}}'` を呼び出して NDJSON を parse する。
 * `--no-trunc` で id をフル取得。
 *
 * docker ps の Names フィールドは "/cernere-backend-dev,/cernere-postgres-1" のように
 * 複数 alias がカンマ区切りで来ることがあるので split する。
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
      // line broken — skip
    }
  }
  return containers;
}

function execDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
