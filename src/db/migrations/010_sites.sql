-- 010_sites: code and websites stored on GitHub, published to Vercel / Netlify / Cloudflare Pages / GitHub Pages.
-- A repository is an artifact (provider 'github', kind 'site' or 'code', external_id 'owner/name'); meta holds its
-- branch, last commit and the private preview token. Additive only.
ALTER TABLE artifacts ADD COLUMN meta TEXT;                        -- JSON, provider-specific (e.g. {full_name, branch, head, preview_token})

-- Current publication of a site per hosting service (history lives in task logs and the audit log).
CREATE TABLE deployments (
  id          INTEGER PRIMARY KEY,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,                                       -- vercel | netlify | cloudflare | github_pages
  project     TEXT,                                                -- project / site name or id at that service
  url         TEXT,                                                -- public address of the site
  status      TEXT NOT NULL DEFAULT 'queued',                      -- queued | building | ready | error
  commit_sha  TEXT,
  error       TEXT,
  approval_id INTEGER REFERENCES approvals(id) ON DELETE SET NULL,
  deployed_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (artifact_id, provider)
);
CREATE INDEX idx_deployments_status ON deployments(status);
