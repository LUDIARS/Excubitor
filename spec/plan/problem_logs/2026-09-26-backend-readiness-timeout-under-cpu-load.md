---
tags: [supervisor, local-control, readiness, restart-loop, cpu-load]
date: 2026-09-26
kind: problem
---

# CPU 高負荷で supervisor が起動途中の Ex backend を殺し、再起動を 13 回繰り返した

- Date: 2026-09-26
- Status: 修正 PR 提出 (readiness timeout の設定化・1 回延長・起動時間の記録、spec/plan/local-control.md §2.1)
- Area: local-control / supervisor / Ex backend readiness
- Severity: high — CPU 負荷が続く間 Ex の Web UI / API が戻らない

## Summary

PC の CPU が 100% の間、Ex backend の起動 (catalog 同期 104 件・file-tail・Redis キャッシュ初期化) が
26〜35 秒かかった。supervisor の readiness は 30 秒固定 (`src/local-control/excubitor-backend.ts`) で、
listen 直前の backend を `Excubitor backend health readiness timed out after 30000ms: fetch failed` で
停止し、再起動を 13 回繰り返した。平常時の listen は 4 秒前後。

## Evidence

- supervisor ログ: `Excubitor backend health readiness timed out after 30000ms: fetch failed` で停止 →
  再起動が 13 回続いた。
- 起動時間: CPU 100% 時 26〜35 秒、平常時 4 秒前後。
- Redis は 14ms で応答しており、この再起動ループとは無関係。backend ログの
  `Redis cache unavailable (redis command timeout)` は別の問題として扱う。

## Root Cause

readiness timeout が平常時の起動時間だけを前提にした固定値で、プロセスが生きて起動処理を進めている
ことを考慮せずに打ち切っていた。打ち切り後の再起動も同じ負荷の下で同じ時間がかかるため収束しない。

## Fix

- timeout を env `EXCUBITOR_BACKEND_READINESS_TIMEOUT_MS` → config store → 既定 90000ms で解決
  (範囲 10000〜600000ms)。
- timeout 到達時に backend プロセスが生きていれば同じ長さの猶予を 1 回だけ与える
  (`readinessDecision`)。
- 起動にかかった時間を supervisor ログと `excubitor status` の `last_startup_ms` に出す。
- 反映には supervisor 自体の再起動が要る (readiness 判定は supervisor プロセスのコード)。

## Fix Requirements (unresolved)

- config store の `settings.backendReadinessTimeoutMs` を書き込む UI / API は未整備。現状は env で設定する。
