CREATE TABLE IF NOT EXISTS articles (
  url TEXT PRIMARY KEY,
  item_json TEXT NOT NULL,
  content TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  url TEXT PRIMARY KEY REFERENCES articles(url),
  verdict TEXT CHECK (verdict IN ('useful','topic','quality','known') OR verdict IS NULL),
  is_read INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS articles_updated ON articles(updated_at DESC);
CREATE INDEX IF NOT EXISTS digests_generated ON digests(generated_at DESC);
CREATE INDEX IF NOT EXISTS feedback_saved ON feedback(saved, updated_at DESC);
