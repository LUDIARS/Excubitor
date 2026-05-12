-- Excubitor v0.1 initial schema
--
-- 冪等: CLAUDE.md (Cernere) のマイグレーション規約に従い、 IF NOT EXISTS を多用。
-- ランナーは Cernere infra 共通の migrate.mjs (SQL 連番、 _migration_history で追跡)。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────── hosts ───────────────
CREATE TABLE IF NOT EXISTS hosts (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT         NOT NULL,
    hostname          TEXT         NOT NULL,
    agent_version     TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hosts_active ON hosts (is_active) WHERE is_active;

-- ─────────────── services (catalog snapshot) ───────────────
CREATE TABLE IF NOT EXISTS services (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    code             TEXT         NOT NULL UNIQUE,
    name             TEXT         NOT NULL,
    catalog_snapshot JSONB        NOT NULL,
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_services_active ON services (is_active) WHERE is_active;

-- ─────────────── service_instances ───────────────
CREATE TABLE IF NOT EXISTS service_instances (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID         NOT NULL REFERENCES services(id),
    host_id         UUID         REFERENCES hosts(id),
    pid             INTEGER,
    docker_id       TEXT,
    state           TEXT         NOT NULL DEFAULT 'unknown',
    last_seen_at    TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    exit_code       INTEGER,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_si_service ON service_instances (service_id);
CREATE INDEX IF NOT EXISTS idx_si_host    ON service_instances (host_id);
CREATE INDEX IF NOT EXISTS idx_si_state   ON service_instances (state);

-- ─────────────── liveness_history (TTL 30d、 cron で sweep) ───────────────
CREATE TABLE IF NOT EXISTS liveness_history (
    id                  BIGSERIAL    PRIMARY KEY,
    service_instance_id UUID         NOT NULL REFERENCES service_instances(id),
    probed_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ok                  BOOLEAN      NOT NULL,
    latency_ms          INTEGER,
    detail              JSONB
);

CREATE INDEX IF NOT EXISTS idx_lh_si_probed ON liveness_history (service_instance_id, probed_at DESC);

-- ─────────────── process_logs (TTL 7d) ───────────────
CREATE TABLE IF NOT EXISTS process_logs (
    id                  BIGSERIAL    PRIMARY KEY,
    service_instance_id UUID         NOT NULL REFERENCES service_instances(id),
    ts                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    level               TEXT,
    line                TEXT         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pl_si_ts ON process_logs (service_instance_id, ts DESC);

-- ─────────────── error_rules ───────────────
CREATE TABLE IF NOT EXISTS error_rules (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT         NOT NULL,
    pattern       TEXT         NOT NULL,
    pattern_type  TEXT         NOT NULL DEFAULT 'regex',
    severity      TEXT         NOT NULL DEFAULT 'error',
    service_codes TEXT[],
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_er_active ON error_rules (is_active) WHERE is_active;

-- ─────────────── error_tasks (triage queue) ───────────────
CREATE TABLE IF NOT EXISTS error_tasks (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id             UUID         REFERENCES error_rules(id),
    service_instance_id UUID         REFERENCES service_instances(id),
    severity            TEXT         NOT NULL DEFAULT 'error',
    summary             TEXT         NOT NULL,
    log_excerpt         TEXT,
    occurrence_count    INTEGER      NOT NULL DEFAULT 1,
    first_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    state               TEXT         NOT NULL DEFAULT 'open',
    snooze_until        TIMESTAMPTZ,
    triaged_by          TEXT,
    triaged_at          TIMESTAMPTZ,
    note                TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_state ON error_tasks (state) WHERE state IN ('open', 'ack', 'snoozed');
CREATE INDEX IF NOT EXISTS idx_et_si    ON error_tasks (service_instance_id, last_seen_at DESC);

-- ─────────────── audit_log ───────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL    PRIMARY KEY,
    ts          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actor       TEXT,
    action      TEXT         NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    payload     JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit_log (actor, ts DESC);
