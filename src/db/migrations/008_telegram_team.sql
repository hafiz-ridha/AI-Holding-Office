-- 008_telegram_team: a Telegram group with Topics where every AI employee has their own topic (plus one topic for
-- reports & notifications). The owner talks to an employee by writing in that employee's topic.
-- Additive only.
ALTER TABLE telegram_settings ADD COLUMN team_chat_id TEXT;         -- the forum group linked with /team
ALTER TABLE telegram_settings ADD COLUMN team_title TEXT;
ALTER TABLE telegram_settings ADD COLUMN report_thread_id INTEGER;  -- topic of the report chat (forum groups)
CREATE TABLE telegram_topics (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                                       -- employee | reports
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  thread_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  color       INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tg_topics_thread ON telegram_topics(chat_id, thread_id);
CREATE UNIQUE INDEX idx_tg_topics_employee ON telegram_topics(chat_id, employee_id) WHERE employee_id IS NOT NULL;
