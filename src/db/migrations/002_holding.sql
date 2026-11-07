-- 002_holding: multi-business holding structure. Additive only: no column/table is dropped or renamed.
-- Rows created before this migration keep business_id = NULL, meaning "holding / general context".

CREATE TABLE businesses (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  industry            TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  logo_file           TEXT,
  color               TEXT NOT NULL DEFAULT '#3b82f6',
  status              TEXT NOT NULL DEFAULT 'active',          -- active | inactive
  manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  extra_access        TEXT NOT NULL DEFAULT '[]',              -- owner-granted: business ids this manager may also read
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Which employees handle which business (business staff and, optionally, shared services).
CREATE TABLE business_employees (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, employee_id)
);
CREATE INDEX idx_business_employees_employee ON business_employees(employee_id);

-- holding = Group CEO level, business = business manager / business staff, shared = shared services.
ALTER TABLE employees ADD COLUMN org_unit TEXT NOT NULL DEFAULT 'shared';
UPDATE employees SET org_unit = 'holding' WHERE is_manager = 1;

-- Task hierarchy: holding task -> business task -> employee subtask.
ALTER TABLE tasks ADD COLUMN business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN level TEXT;                         -- holding | business | employee (NULL = v1 row)
ALTER TABLE tasks ADD COLUMN manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_business ON tasks(business_id, created_at);
UPDATE tasks SET level = CASE WHEN kind = 'instruction' THEN 'holding' ELSE 'employee' END WHERE level IS NULL;

-- Business scoping for AI context and activity data.
ALTER TABLE conversations ADD COLUMN business_id INTEGER;
ALTER TABLE memories ADD COLUMN business_id INTEGER;
ALTER TABLE usage_logs ADD COLUMN business_id INTEGER;
ALTER TABLE task_logs ADD COLUMN business_id INTEGER;
ALTER TABLE audit_logs ADD COLUMN business_id INTEGER;
CREATE INDEX idx_conversations_business ON conversations(business_id, id);
CREATE INDEX idx_memories_scope ON memories(employee_id, business_id, id);
CREATE INDEX idx_usage_business ON usage_logs(business_id, created_at);
CREATE INDEX idx_task_logs_business ON task_logs(business_id, id);

-- Documents & knowledge base. business_id NULL = holding-level document (Group CEO only).
CREATE TABLE documents (
  id          INTEGER PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'knowledge',               -- knowledge | document
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  filename    TEXT,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_documents_business ON documents(business_id, updated_at);

-- Explicit, owner-granted sharing of a document with another business.
CREATE TABLE document_shares (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, business_id)
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, content = 'documents', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- Financial records are always tied to exactly one business (never mixed).
CREATE TABLE financial_records (
  id          INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  record_date TEXT NOT NULL,                                   -- YYYY-MM-DD
  type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category    TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL CHECK (amount >= 0),
  currency    TEXT NOT NULL DEFAULT 'IDR',
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_financial_business_date ON financial_records(business_id, record_date);

-- Business reports (scope=business) and consolidated holding reports (scope=holding, business_id NULL).
CREATE TABLE business_reports (
  id          INTEGER PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  scope       TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_reports_business ON business_reports(business_id, created_at);
CREATE INDEX idx_reports_scope ON business_reports(scope, created_at);

-- Owner approvals for risky recommendations. Approving only records the decision: AI never executes actions.
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  business_id   INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',               -- pending | approved | rejected
  decided_by    TEXT,
  decision_note TEXT,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);
CREATE INDEX idx_approvals_business ON approvals(business_id, created_at);
