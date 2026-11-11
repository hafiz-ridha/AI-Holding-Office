-- 009_agents: AI employees as agents with tools. Connections to outside services (secrets encrypted), an index of
-- files the AI stored outside (Google Drive now; GitHub/Vercel/Netlify/Supabase later), and approvals that carry an
-- action which runs only after the owner approves it. Additive only.

-- One row per outside service. Secrets (client secret, refresh token, API tokens) only in secret_enc (AES-GCM with
-- APP_SECRET); config holds non-secret values such as the client id and the ids of folders the app created.
CREATE TABLE connections (
  provider     TEXT PRIMARY KEY,                                   -- google_drive | github | vercel | netlify | supabase
  status       TEXT NOT NULL DEFAULT 'disconnected',               -- disconnected | pending | connected | expired | error
  account      TEXT,                                               -- e.g. the Google account email
  config       TEXT NOT NULL DEFAULT '{}',
  secret_enc   TEXT,
  secret_hint  TEXT,
  error        TEXT,
  connected_at INTEGER,
  updated_at   INTEGER NOT NULL
);

-- Files the AI made, stored at an outside service. The app keeps the index and the link (the text of results stays in
-- tasks/business_reports for AI context and search).
CREATE TABLE artifacts (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,                                       -- google_drive | github | vercel | netlify | supabase
  kind        TEXT NOT NULL,                                       -- document | report | code | image | database | site | file
  external_id TEXT,
  url         TEXT,
  title       TEXT NOT NULL,
  mime        TEXT,
  business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending',                     -- pending | synced | failed | trashed
  source      TEXT NOT NULL DEFAULT 'agent',                       -- agent (a tool call) | auto (automatic save)
  content     TEXT,                                                -- Markdown waiting to be uploaded (cleared once synced)
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_business ON artifacts(business_id, created_at);
CREATE INDEX idx_artifacts_status ON artifacts(status, updated_at);
CREATE UNIQUE INDEX idx_artifacts_external ON artifacts(provider, external_id) WHERE external_id IS NOT NULL;

-- An approval may carry an action (a tool call the AI asked for). It runs only after the owner approves it.
ALTER TABLE approvals ADD COLUMN action TEXT;                      -- JSON {tool, args, employee_id}
ALTER TABLE approvals ADD COLUMN action_status TEXT;               -- waiting | running | done | failed | cancelled
ALTER TABLE approvals ADD COLUMN action_result TEXT;
ALTER TABLE approvals ADD COLUMN action_at INTEGER;
