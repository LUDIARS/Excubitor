/**
 * Revisor runtime スモーク (登録テストケース runtime-smoke から実行される)。
 *
 * SafeMode + 隔離ポート (27332) で backend を tsx 起動し、 /health が 200 を
 * 返したら成功。 起動セット autolaunch は SafeMode が抑止し、 既定ポートでない
 * ため共有 .mcp.json の reconcile もスキップされる (本物の常駐系に影響しない)。
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 27332;
const BOOT_TIMEOUT_MS = 120_000;
// 相対パスの tsx / エントリを解決するため、 呼び出し元の cwd ではなくリポジトリ root で起動する。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// POSIX では tsx CLI が実サーバを孫プロセスとして起動するため、 プロセスグループごと
// 落とせるよう detached で起動する (Windows は taskkill /T が木を辿る)。
const DETACHED = process.platform !== 'win32';

const child = spawn(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      EXCUBITOR_PORT: String(PORT),
      EXCUBITOR_SAFE_MODE: '1',
      EXCUBITOR_LOG_LEVEL: 'warn',
    },
    stdio: 'ignore',
    detached: DETACHED,
  },
);

let exited = false;
let exitInfo = '';
let spawnError = null;
child.once('exit', (code, signal) => {
  exited = true;
  exitInfo = signal ? `signal=${signal}` : `code=${code}`;
});
child.once('error', (err) => {
  exited = true;
  spawnError = err;
});

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    if (DETACHED) {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        /* グループが既に消えていれば単体 kill にフォールバック */
      }
    }
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

const deadline = Date.now() + BOOT_TIMEOUT_MS;
let ok = false;
let health = null;
while (Date.now() < deadline) {
  if (exited) {
    console.error(
      spawnError
        ? `runtime smoke: backend failed to spawn (${spawnError.message})`
        : `runtime smoke: backend exited early (${exitInfo})`,
    );
    break;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (res.ok) {
      health = await res.json().catch(() => null);
      ok = true;
      break;
    }
  } catch {
    /* not listening yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

killTree(child.pid);
if (!ok) {
  // 早期 exit は既に理由を出しているので、 ここは純粋な timeout だけ報告する。
  if (!exited) console.error(`runtime smoke: /health unreachable within ${BOOT_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}
// /health は instance_token を含むため body をそのまま出さず、 判定に要る項目だけ出す。
console.log(`runtime smoke ok: service=${health?.service ?? '?'} safe_mode=${health?.safe_mode ?? '?'}`);
process.exit(0);
