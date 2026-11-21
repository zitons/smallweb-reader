CREATE INDEX IF NOT EXISTS articles_published ON articles(published_at DESC, url DESC);
