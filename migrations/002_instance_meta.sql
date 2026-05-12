-- service_instances に動作中インスタンスのメタ情報を追加
--
-- - git_branch / git_hash / git_dirty : cwd で git rev-parse して取得
-- - package_version : cwd/package.json の "version"
-- - port : 主要 listening port (catalog の port から、 もしくは docker inspect から)
-- - extra : 拡張用 jsonb

ALTER TABLE service_instances
  ADD COLUMN IF NOT EXISTS git_branch      TEXT,
  ADD COLUMN IF NOT EXISTS git_hash        TEXT,
  ADD COLUMN IF NOT EXISTS git_dirty       BOOLEAN,
  ADD COLUMN IF NOT EXISTS package_version TEXT,
  ADD COLUMN IF NOT EXISTS port            INTEGER,
  ADD COLUMN IF NOT EXISTS extra           JSONB;
