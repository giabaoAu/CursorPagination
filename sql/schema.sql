-- posts: minimal feed model for cursor pagination
-- created_at is the primary temporal ordering; (id) breaks ties.

CREATE TABLE IF NOT EXISTS posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  body TEXT NOT NULL
);

-- Keyset pagination-friendly composite index.
-- Matches ORDER BY created_at DESC, id DESC and the tuple WHERE clauses.
CREATE INDEX IF NOT EXISTS posts_user_created_at_desc_id_desc_idx
  ON posts (user_id, created_at DESC, id DESC);

