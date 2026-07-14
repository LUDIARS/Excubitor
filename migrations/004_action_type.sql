-- auto_fix_runs を「調査 / 修正」 の 2 系統に拡張する。
--
-- v0.1 の auto_fix_runs は「自動修正の 1 回分」 を記録するテーブルだった。
-- 自動 trigger を廃止して、 ユーザが手動で「調査」 (= 解析のみ、 git 操作なし) と
-- 「修正」 (= 既存の auto-fix と同じ branch + commit + push) を選べる UI に
-- 変えたため、 どちらの action だったかを区別する action_type を足す。
--
-- 既存行は全部 'fix' とみなす (= v0.1 で動いていたのは fix 動作のみ)。

ALTER TABLE auto_fix_runs
  ADD COLUMN IF NOT EXISTS action_type TEXT NOT NULL DEFAULT 'fix';

-- action_type で頻繁にフィルタする想定 (UI で「調査だけ」「修正だけ」 を絞り
-- たい等)。 service_code + state と組み合わせる複合 index は今のところ不要。
CREATE INDEX IF NOT EXISTS idx_afr_action_type ON auto_fix_runs (action_type);
