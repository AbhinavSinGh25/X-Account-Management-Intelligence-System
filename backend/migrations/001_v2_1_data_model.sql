-- X Follow Intelligence V2.1 data-model migration
-- Run once against x_follow_intelligence before using the updated backend.

BEGIN;

CREATE TEMP TABLE networking_post_merge_map AS
SELECT
  older.id AS old_id,
  (
    SELECT newer.id
    FROM networking_posts newer
    WHERE newer.user_id = older.user_id
      AND newer.x_post_id = older.x_post_id
    ORDER BY newer.created_at DESC, newer.id DESC
    LIMIT 1
  ) AS keep_id
FROM networking_posts older
WHERE EXISTS (
  SELECT 1
  FROM networking_posts newer
  WHERE newer.user_id = older.user_id
    AND newer.x_post_id = older.x_post_id
    AND newer.id <> older.id
);

UPDATE follows f
SET source_post_id = m.keep_id
FROM networking_post_merge_map m
WHERE f.source_post_id = m.old_id;

UPDATE relationship_events e
SET source_post_id = m.keep_id
FROM networking_post_merge_map m
WHERE e.source_post_id = m.old_id;

DELETE FROM networking_posts p
USING networking_post_merge_map m
WHERE p.id = m.old_id
  AND p.id <> m.keep_id;

-- Prevent duplicate observations for the same X post per app user.
CREATE UNIQUE INDEX IF NOT EXISTS networking_posts_user_x_post_unique
ON networking_posts (user_id, x_post_id);

-- Keep follow status values consistent with the extension.
ALTER TABLE follows
DROP CONSTRAINT IF EXISTS follows_current_status_check;

ALTER TABLE follows
ADD CONSTRAINT follows_current_status_check
CHECK (
  current_status IN (
    'WAITING',
    'CHECKING',
    'FOLLOWED_BACK',
    'NOT_FOLLOWED_BACK',
    'RETRY_PENDING',
    'CHECK_FAILED',
    'UNFOLLOWED'
  )
);

COMMIT;
