-- One-off backfill (ST-147, for ST-139): marks read every unread `rules` inbox item whose document
-- is no longer the rules of a live project (the inverse of listInbox's filter). Items that went
-- stale before retireRulesItems existed would otherwise block a new announcement when their
-- document becomes the rules again.
UPDATE "inbox_items" AS i
SET "read_at" = now()
WHERE i."kind" = 'rules'
  AND i."read_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "documents" AS d
    JOIN "projects" AS p ON p."id" = d."project_id"
    WHERE d."id" = i."document_id"
      AND d."deleted_at" IS NULL
      AND p."rules_document_id" = d."id"
      AND p."archived_at" IS NULL
  );
