-- v0.1 patch: auto-fix engine
--
-- error_tasks を auto-fix workflow に対応:
--   - auto_fix_state    NULL / pending / running / succeeded / failed / disabled / awaiting_human
--   - auto_fix_attempts 1 error_task につき自動 trigger 回数 (max 1 で人間判断へ)
--   - auto_fix_run_id   最新の auto_fix_run の id
--
-- auto_fix_runs: Claude Code spawn 1 回分の記録

ALTER TABLE error_tasks
  ADD COLUMN IF NOT EXISTS auto_fix_state    TEXT,
  ADD COLUMN IF NOT EXISTS auto_fix_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_fix_run_id   UUID;

CREATE TABLE IF NOT EXISTS auto_fix_runs (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    error_task_id   UUID         NOT NULL REFERENCES error_tasks(id),
    service_code    TEXT         NOT NULL,
    agent           TEXT         NOT NULL DEFAULT 'claude-code',
    -- pending → running → fixed → verifying → succeeded | failed
    state           TEXT         NOT NULL DEFAULT 'pending',
    triggered_by    TEXT,         -- 'auto' | 'manual' | actor id
    prompt          TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    exit_code       INTEGER,
    stdout_tail     TEXT,
    stderr_tail     TEXT,
    branch          TEXT,
    commit_hash     TEXT,
    pr_url          TEXT,
    verify_result   TEXT,         -- ok | health_failed | still_crashing | not_attempted
    error_message   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afr_task  ON auto_fix_runs (error_task_id);
CREATE INDEX IF NOT EXISTS idx_afr_state ON auto_fix_runs (state);
