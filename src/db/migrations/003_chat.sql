-- 003_chat: agent chat feed + owner messages. Additive only.
-- business_id NULL = holding / HQ channel; otherwise the business channel (isolated per business).
CREATE TABLE chat_messages (
  id                    INTEGER PRIMARY KEY,
  business_id           INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  sender_type           TEXT NOT NULL,                 -- owner | employee | system
  sender_employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  sender_name           TEXT NOT NULL,                 -- snapshot, so history stays readable after renames/deletes
  recipient_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  recipient_name        TEXT,
  task_id               INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  kind                  TEXT NOT NULL DEFAULT 'message', -- message | note | command | assign | start | meeting | done | report | fail | approval | system
  content               TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_chat_business ON chat_messages(business_id, id);
CREATE INDEX idx_chat_created ON chat_messages(created_at);
CREATE INDEX idx_chat_task ON chat_messages(task_id);
