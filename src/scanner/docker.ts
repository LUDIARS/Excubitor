import { spawn } from 'node:child_process';

export interface DockerContainer {
  id: string;
  names: string[];          // 1 繧ｳ繝ｳ繝・リ縺ｫ隍・焚 alias 縺御ｻ倥￥縺溘ａ驟榊・
  image: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | string;
  status: string;           // "Up 10 minutes", "Exited (0) 3 hours ago" 遲・
  ports: string;
}

/**
 * `docker ps -a --format '{{json .}}'` 繧貞他縺ｳ蜃ｺ縺励※ NDJSON 繧・parse 縺吶ｋ縲・
 * `--no-trunc` 縺ｧ id 繧偵ヵ繝ｫ蜿門ｾ励・
 *
 * docker ps 縺ｮ Names 繝輔ぅ繝ｼ繝ｫ繝峨・ "/cernere-backend-dev,/cernere-db-1" 縺ｮ繧医≧縺ｫ
 * 隍・焚 alias 縺後き繝ｳ繝槫玄蛻・ｊ縺ｧ譚･繧九％縺ｨ縺後≠繧九・縺ｧ split 縺吶ｋ縲・
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
      // line broken 窶・skip
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



