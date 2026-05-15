# 品質レビュー — Excubitor v0.1

評価: **B**

## 良い点

- TypeScript strict + ESM、 Node >=22 明示 (`package.json:28-30`)、 import 拡張子 `.js` 統一で ESM 互換。
- コメント密度が高く、 設計意図が source に残る (e.g. `src/log/error-detector.ts:14-17` の auto-trigger 廃止メモ、 `src/auto_fix/investigate.ts:200-202` の revert しない判断)。
- try/catch 粒度が一貫 (`/* noop */` の使い方が統一、 `src/process/manager.ts:117, 120`、 `src/index.ts:218-220`)。
- zod schema を catalog / API 両方で活用 (`src/catalog/loader.ts:6-89`、 API 各 schema)。 default 値も含めて宣言的。
- migrations が冪等 (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`、 LUDIARS 標準)。

## 懸念

- **Q-1 (medium)** テストコード 0 件。 `package.json` に test script 無し。 unsafe-file regex / infisical filter / dev-process パーザ / prompt builder は純粋関数で test 追加が容易。 `vitest` 導入を推奨。
- **Q-2 (medium)** `(err as Error).message` の握り (`src/auto_fix/runner.ts:155, 178-180`, `src/process/manager.ts:107, 161` ほか)。 `err instanceof Error` ガード推奨。
- **Q-3 (medium)** magic number 散在 (`cliTimeoutMs` / `verifyTimeoutMs` / `RELOAD_INTERVAL_MS` / `DEFAULT_INTERVAL_MS` / SSE ping 25s / backoff cap 30s)。 1 箇所集約推奨。
- **Q-4 (medium)** `applyInjectFilter` の include / exclude / prefix 評価順序がコメント未明示 (`src/infisical/filter.ts:20-25`)。 現実装は元キーで判定 → prefix を出力に付与。
- **Q-5 (low)** `let buf = ''` パターンに上限なし (`src/process/manager.ts:169-184`、`src/log/docker-tail.ts:59-75`)。 巨大単一行で memory build-up。
- **Q-6 (low)** `dirname(svc.compose_file)` (`src/auto_fix/runner.ts:55`、`investigate.ts:56`) で Windows path mixed separator。 `path.win32` 明示が安全。
- **Q-7 (low)** commit history が main 経由でなく feature ブランチ上で merge を取り込み (`d2ac911`)、 history が直線でない。
- **Q-8 (low)** `frontend/config.ts:25-27` の `allowedHosts` に `vtn-game.com` がハードコード commit。 `.example.com` 化推奨。
- **Q-9 (low)** Reviews router の sync I/O 一連 (Q-1 重複箇所、 `fs/promises` 化で hono の async 文化に揃う)。
- **Q-10 (low)** `dev-process.md` 抽出は 1 行限定 (`src/process/dev-process-md.ts:34-35`)。 catalog 移行で multi-line shell wrapper が要る。
- **Q-11 (low)** pino logger transport が default stdout JSON のみ。 Excubitor 自身を catalog で self-monitoring する閉ループが無い。

## 結論

v0.1 scaffold としては品質 B。 コメント密度・命名・schema 駆動の 3 点で読みやすい。 テスト 0 と magic number 散在が次の品質改善ターゲット。
