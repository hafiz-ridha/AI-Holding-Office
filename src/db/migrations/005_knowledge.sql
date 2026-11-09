-- 005_knowledge: "Second Brain". Knowledge notes distilled from finished WORK (task results, business and holding
-- reports) plus facts written by the owner. Shared by every employee and every AI model of the same scope and
-- searchable with FTS5. Quick chat replies (small talk) are never stored here. Additive only.
CREATE TABLE knowledge_notes (
  id           INTEGER PRIMARY KEY,
  business_id  INTEGER REFERENCES businesses(id) ON DELETE CASCADE,   -- NULL = holding level
  kind         TEXT NOT NULL DEFAULT 'work',        -- work (from a finished task) | fact (written by the owner)
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  author       TEXT,                                -- snapshot: employee name or owner username
  provider     TEXT,                                -- AI provider/model that wrote the source answer
  model        TEXT,
  ceo_only     INTEGER NOT NULL DEFAULT 0,          -- holding reports mention every business: Group CEO only
  pinned       INTEGER NOT NULL DEFAULT 0,          -- pinned notes are always given to the AI in their scope
  importance   INTEGER NOT NULL DEFAULT 1,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_knowledge_task ON knowledge_notes(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_knowledge_scope ON knowledge_notes(business_id, pinned, updated_at);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, content, content = 'knowledge_notes', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_notes BEGIN
  INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_notes BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER knowledge_au AFTER UPDATE OF title, content ON knowledge_notes BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- Which notes were given to the AI for a task (JSON [{id, title}]), shown under its answer.
ALTER TABLE tasks ADD COLUMN knowledge_refs TEXT;
