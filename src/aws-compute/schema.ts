/** Site-local settings and lifecycle journal; the shared DB owns migration and durability. */
export const AWS_COMPUTE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS aws_compute_identity (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS aws_compute_targets (id TEXT PRIMARY KEY, config TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS aws_compute_jobs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    target_id TEXT NOT NULL,
    target TEXT NOT NULL,
    runner TEXT NOT NULL,
    launch_token TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    inputs TEXT,
    submission TEXT NOT NULL,
    release TEXT NOT NULL,
    resource_id TEXT,
    observation TEXT,
    issue TEXT,
    created_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    submitted_at INTEGER,
    observed_at INTEGER,
    stop_requested_at INTEGER,
    released_at INTEGER,
    next_check_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_aws_compute_active_target ON aws_compute_jobs(target_id)
    WHERE release IN ('pending', 'requested')`,
  `CREATE INDEX IF NOT EXISTS idx_aws_compute_due ON aws_compute_jobs(next_check_at)
    WHERE release IN ('pending', 'requested')`,
];
