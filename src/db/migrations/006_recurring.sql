-- 006_recurring: recurring tasks (e.g. daily news digest, weekly trend research, social media ideas)
-- and the web sources the AI was given for a task (automatic web research).
-- The scheduler creates a normal task from each rule when it is due; tasks remember which rule created them.
-- Additive only.
CREATE TABLE recurring_tasks (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL,                       -- holding | business | direct (same as a manual task)
  business_id    INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  priority       TEXT NOT NULL DEFAULT 'normal',      -- low | normal | high | urgent
  frequency      TEXT NOT NULL,                       -- daily | weekdays | weekly | monthly | hours
  time_of_day    TEXT NOT NULL DEFAULT '08:00',       -- HH:MM in the holding timezone (first run of the day for "hours")
  weekdays       TEXT,                                -- JSON array of ISO weekdays 1 (Mon) .. 7 (Sun), for weekly
  day_of_month   INTEGER,                             -- 1..28, for monthly
  every_hours    INTEGER,                             -- 1..24, for hours
  template       TEXT,                                -- preset it was created from (trend, news, social, ...)
  skip_if_running INTEGER NOT NULL DEFAULT 1,         -- skip a run while the previous task is still active
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    INTEGER,
  last_run_at    INTEGER,
  last_task_id   INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  last_status    TEXT,                                -- created | skipped | error
  last_error     TEXT,
  run_count      INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_recurring_due ON recurring_tasks(enabled, next_run_at);
ALTER TABLE tasks ADD COLUMN recurring_id INTEGER REFERENCES recurring_tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_recurring ON tasks(recurring_id);
-- Web sources (JSON [{n, title, url, source, date}]) fetched for this task by the automatic web research.
ALTER TABLE tasks ADD COLUMN web_refs TEXT;
