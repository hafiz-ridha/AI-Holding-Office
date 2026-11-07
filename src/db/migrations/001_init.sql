-- 001_init: initial schema. Timestamps are INTEGER milliseconds since epoch (UTC).

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  last_login_at   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- sha256(token)
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE providers (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,                 -- openrouter | ninerouter | openai_compatible
  preset              TEXT NOT NULL DEFAULT 'custom',
  base_url            TEXT NOT NULL,
  api_key_enc         TEXT,
  api_key_hint        TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  is_default          INTEGER NOT NULL DEFAULT 0,
  priority            INTEGER NOT NULL DEFAULT 100,  -- lower = tried earlier as backup
  default_model       TEXT,
  fallback_models     TEXT NOT NULL DEFAULT '[]',    -- JSON array of model ids
  timeout_ms          INTEGER NOT NULL DEFAULT 60000,
  max_retries         INTEGER NOT NULL DEFAULT 1,
  rpm_limit           INTEGER NOT NULL DEFAULT 0,    -- 0 = unlimited
  daily_request_limit INTEGER NOT NULL DEFAULT 0,    -- 0 = unlimited
  status              TEXT NOT NULL DEFAULT 'unknown',
  status_message      TEXT,
  last_checked_at     INTEGER,
  cooldown_until      INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE models (
  id                 INTEGER PRIMARY KEY,
  provider_id        INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id           TEXT NOT NULL,
  name               TEXT,
  is_free            INTEGER NOT NULL DEFAULT 0,
  context_length     INTEGER,
  pricing_prompt     REAL,      -- USD per token
  pricing_completion REAL,      -- USD per token
  cooldown_until     INTEGER,
  updated_at         INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);
CREATE INDEX idx_models_provider_free ON models(provider_id, is_free);

CREATE TABLE employees (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  role_key      TEXT NOT NULL DEFAULT 'custom',   -- ceo | secretary | researcher | developer | marketing | custom
  is_manager    INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT NOT NULL DEFAULT '{}',      -- JSON palette for the procedural sprite
  personality   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id   INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  model         TEXT,
  temperature   REAL NOT NULL DEFAULT 0.7,
  max_tokens    INTEGER NOT NULL DEFAULT 0,      -- 0 = use global setting
  enabled       INTEGER NOT NULL DEFAULT 1,
  desk_index    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'idle',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY,
  parent_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                  -- instruction | subtask | direct
  phase           TEXT,                           -- instruction: planning | executing | synthesizing | done
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL,                  -- owner | telegram:<id> | employee:<slug>
  employee_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  priority        INTEGER NOT NULL DEFAULT 2,     -- 1 low, 2 normal, 3 high, 4 urgent
  status          TEXT NOT NULL DEFAULT 'pending',-- pending | assigned | processing | completed | failed | cancelled
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  started_at      INTEGER,
  completed_at    INTEGER,
  result          TEXT,
  plan            TEXT,                           -- JSON plan produced by the manager
  error           TEXT,
  provider_name   TEXT,
  model_used      TEXT,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_queue ON tasks(status, next_attempt_at, priority);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_employee ON tasks(employee_id, created_at);
CREATE INDEX idx_tasks_created ON tasks(created_at);
CREATE INDEX idx_tasks_completed ON tasks(completed_at);

CREATE TABLE task_logs (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  level      TEXT NOT NULL DEFAULT 'info',
  event      TEXT NOT NULL,
  message    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_logs_task ON task_logs(task_id, id);
CREATE INDEX idx_task_logs_created ON task_logs(created_at);

CREATE TABLE conversations (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  role        TEXT NOT NULL,     -- user | assistant
  content     TEXT NOT NULL,
  provider    TEXT,
  model       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_conversations_task ON conversations(task_id, id);
CREATE INDEX idx_conversations_created ON conversations(created_at);

CREATE TABLE memories (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  importance  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_memories_employee ON memories(employee_id, created_at);

CREATE TABLE usage_logs (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  provider_id   INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  provider_name TEXT,
  model         TEXT,
  purpose       TEXT,           -- plan | work | synthesis | test
  ok            INTEGER NOT NULL,
  http_status   INTEGER,
  error         TEXT,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  estimated     INTEGER NOT NULL DEFAULT 0,  -- 1 if token counts are estimated (provider sent none)
  cost_usd      REAL,
  latency_ms    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_usage_created ON usage_logs(created_at);
CREATE INDEX idx_usage_provider ON usage_logs(provider_id, created_at);

CREATE TABLE telegram_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  bot_token_enc         TEXT,
  bot_token_hint        TEXT,
  bot_username          TEXT,
  chat_id               TEXT,
  allowed_user_ids      TEXT NOT NULL DEFAULT '[]',  -- JSON array of numeric ids (as strings)
  report_enabled        INTEGER NOT NULL DEFAULT 0,
  report_time           TEXT NOT NULL DEFAULT '18:00',
  timezone              TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  polling_enabled       INTEGER NOT NULL DEFAULT 1,
  notify_task_started   INTEGER NOT NULL DEFAULT 1,
  notify_task_completed INTEGER NOT NULL DEFAULT 1,
  notify_task_failed    INTEGER NOT NULL DEFAULT 1,
  notify_system_alert   INTEGER NOT NULL DEFAULT 1,
  notify_subtasks       INTEGER NOT NULL DEFAULT 0,
  last_update_id        INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE telegram_reports (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,      -- daily_report | manual_report | task_started | task_completed | task_failed | system_alert | test | command
  report_date TEXT,               -- YYYY-MM-DD in configured timezone (daily_report)
  chat_id     TEXT,
  status      TEXT NOT NULL,      -- sending | sent | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- Guarantees at most one daily report row per date: the scheduler claims the row before sending.
CREATE UNIQUE INDEX uq_telegram_daily ON telegram_reports(report_date) WHERE type = 'daily_report';
CREATE INDEX idx_telegram_reports_created ON telegram_reports(created_at);

CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,     -- JSON encoded
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
