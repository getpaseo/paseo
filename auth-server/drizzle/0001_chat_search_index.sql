-- Full-text search index for chat messages. We compute the tsvector at query
-- time against `message.content` (which stays the source of truth as raw
-- markdown). A functional GIN index lets Postgres use it.
CREATE INDEX IF NOT EXISTS "message_content_fts_idx"
  ON "message"
  USING GIN (to_tsvector('simple', "content"));
